"""Клиент OpenRouter: единственное место, где проект обращается к ИИ.

Правило проекта: ИИ никогда не принимает решений. Он получает уже готовые
цифры от движка и превращает их в человеческий текст. Поэтому здесь нет
никакой логики расчётов — только запрос, ретраи и защита от мусора.

Модели по умолчанию — бесплатные (:free), первая берётся из secrets.env
(AI_MODEL), остальные подключены как запасные, чтобы отчёт вышел даже
если одна модель перегружена или недоступна из РФ.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import httpx

from core.logger import get_logger

log = get_logger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# Бесплатные модели: основная и запасные. Порядок = порядок попыток.
FREE_MODELS: tuple[str, ...] = (
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemini-2.0-flash-exp:free",
    "deepseek/deepseek-chat-v3.1:free",
    "qwen/qwen-2.5-72b-instruct:free",
)

# Сколько ждём ответ модели и сколько раз повторяем при сбое сети
REQUEST_TIMEOUT = 60.0
MAX_RETRIES = 2
RETRY_PAUSE = 1.5

# Ограничения на ответ: короткий текст для карточки в приложении
DEFAULT_MAX_TOKENS = 700
DEFAULT_TEMPERATURE = 0.35

# Текст, который просят у модели, должен укладываться в экран
MAX_ANSWER_CHARS = 1200


# ─── Транслитерация для HTTP-заголовков ────────────────────────
# В заголовках допустимы только ASCII-символы: «AI Маркетолог» туда
# положить нельзя, поэтому переводим название в латиницу.
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", " ": " ",
}


def _ascii(value: str) -> str:
    """Приводит строку к ASCII: нужна для заголовков X-Title и HTTP-Referer."""
    text = (value or "").strip()
    if not text:
        return ""
    if text.isascii():
        return text
    transliterated = "".join(_TRANSLIT.get(char.lower(), char) for char in text)
    return transliterated.encode("ascii", "ignore").decode("ascii").strip()


class OpenRouterError(RuntimeError):
    """Ошибка обращения к ИИ с понятным текстом для логов и интерфейса."""

    def __init__(self, message: str, *, status: int | None = None, model: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.model = model


@dataclass(slots=True)
class OpenRouterClient:
    """Асинхронный клиент OpenRouter с запасными моделями."""

    api_key: str = ""
    model: str = FREE_MODELS[0]
    models: tuple[str, ...] = field(default_factory=lambda: FREE_MODELS)
    timeout: float = REQUEST_TIMEOUT
    app_name: str = "AI Маркетолог"
    site_url: str = ""
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    # ─── Настройка ─────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        """Есть ли ключ: без ключа проект должен работать на шаблонных текстах."""
        return bool(self.api_key and self.api_key.strip() and not self.api_key.startswith("sk-or-v1-xxxx"))

    def chain(self) -> list[str]:
        """Очередь моделей: сначала выбранная в secrets.env, потом запасные."""
        result: list[str] = []
        for candidate in (self.model, *self.models, *FREE_MODELS):
            if candidate and candidate not in result:
                result.append(candidate)
        return result

    def _headers(self) -> dict[str, str]:
        """Заголовки запроса.

        Важно: в HTTP-заголовках допустимы только ASCII-символы, поэтому
        русское название приложения переводим в латиницу. Иначе httpx
        падает с UnicodeEncodeError ещё до отправки запроса.
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            # OpenRouter просит идентифицировать приложение — это вежливо и бесплатно
            "X-Title": _ascii(self.app_name) or "AI Marketer",
        }
        referer = _ascii(self.site_url)
        if referer:
            headers["HTTP-Referer"] = referer
        return headers

    async def __aenter__(self) -> "OpenRouterClient":
        self._client = httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ─── Запросы ───────────────────────────────────────────────

    async def chat(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str | None = None,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> str:
        """Один запрос к конкретной модели. Возвращает текст ответа."""
        if not self.enabled:
            raise OpenRouterError("Ключ OpenRouter не заполнен в secrets.env")

        target = model or self.model
        payload = {
            "model": target,
            "messages": [dict(message) for message in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns_client = self._client is None

        attempt = 0
        try:
            while True:
                attempt += 1
                try:
                    response = await client.post(OPENROUTER_URL, json=payload)
                except httpx.HTTPError as error:
                    if attempt > MAX_RETRIES:
                        raise OpenRouterError(f"Сеть недоступна: {error}", model=target) from error
                    log.warning("Сбой сети при обращении к ИИ — повторяю", model=target, attempt=attempt)
                    await asyncio.sleep(RETRY_PAUSE * attempt)
                    continue

                if response.status_code == 429 and attempt <= MAX_RETRIES:
                    pause = _retry_after(response)
                    log.warning("ИИ просит подождать", model=target, pause=pause)
                    await asyncio.sleep(pause)
                    continue

                if response.status_code == 401:
                    raise OpenRouterError("Ключ OpenRouter не принят — проверьте OPENROUTER_API_KEY", status=401, model=target)
                if response.status_code == 402:
                    raise OpenRouterError("На ключе OpenRouter закончились средства — выберите бесплатную модель", status=402, model=target)
                if response.status_code >= 400:
                    detail = _error_text(response)
                    raise OpenRouterError(f"OpenRouter вернул ошибку {response.status_code}: {detail}", status=response.status_code, model=target)

                return _answer_text(response, target)
        finally:
            if owns_client:
                await client.aclose()

    async def chat_with_fallback(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        temperature: float = DEFAULT_TEMPERATURE,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> tuple[str, str]:
        """Пробует модели по очереди. Возвращает (текст, имя сработавшей модели).

        Если не ответила ни одна модель — бросает OpenRouterError. Вызывающий
        код (ai/advisor.py) в этом случае отдаёт шаблонный текст, поэтому
        приложение никогда не остаётся с пустым экраном.
        """
        errors: list[str] = []
        for candidate in self.chain():
            try:
                text = await self.chat(messages, model=candidate, temperature=temperature, max_tokens=max_tokens)
                if text:
                    log.info("Ответ ИИ получен", model=candidate, chars=len(text))
                    return text, candidate
                errors.append(f"{candidate}: пустой ответ")
            except OpenRouterError as error:
                errors.append(f"{candidate}: {error}")
                log.warning("Модель не ответила — пробую следующую", model=candidate, reason=str(error)[:160])
                if error.status in (401, 402):
                    break  # проблема с ключом, перебор моделей не поможет
        raise OpenRouterError("Ни одна модель не ответила. " + "; ".join(errors[:3]))

    async def health(self) -> dict[str, Any]:
        """Проверка связи: короткий запрос к первой доступной модели."""
        if not self.enabled:
            return {"ok": False, "reason": "нет ключа OpenRouter"}
        try:
            text, model = await self.chat_with_fallback(
                [
                    {"role": "system", "content": "Отвечай одним словом."},
                    {"role": "user", "content": "Скажи «работаю»."},
                ],
                max_tokens=12,
                temperature=0.0,
            )
            return {"ok": True, "model": model, "answer": text[:60]}
        except OpenRouterError as error:
            return {"ok": False, "reason": str(error)[:200]}


def _retry_after(response: httpx.Response) -> float:
    """Сколько секунд просит подождать OpenRouter."""
    raw = response.headers.get("Retry-After") or ""
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    return min(max(value, 2.0), 30.0)


def _error_text(response: httpx.Response) -> str:
    """Достаёт текст ошибки из ответа, не падая на не-JSON."""
    try:
        data = response.json()
    except Exception:  # noqa: BLE001 — OpenRouter иногда отдаёт HTML
        return response.text[:200]
    if isinstance(data, Mapping):
        error = data.get("error")
        if isinstance(error, Mapping):
            return str(error.get("message") or error)[:200]
        return str(error or data)[:200]
    return str(data)[:200]


def _answer_text(response: httpx.Response, model: str) -> str:
    """Разбирает ответ OpenRouter и достаёт текст гипотезы."""
    try:
        data = response.json()
    except json.JSONDecodeError as error:
        raise OpenRouterError("Ответ ИИ не разобрался как JSON", model=model) from error

    choices = data.get("choices") or []
    if not choices:
        raise OpenRouterError("Модель вернула пустой ответ", model=model)

    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):  # некоторые модели отдают массив частей
        content = " ".join(str(part.get("text", part)) if isinstance(part, Mapping) else str(part) for part in content)
    text = str(content or "").strip()
    return clean_answer(text)


def clean_answer(text: str) -> str:
    """Приводит ответ модели к виду, пригодному для экрана.

    Убираем служебные вступления, markdown-заголовки, лишние кавычки и
    обрезаем по границе предложения: карточка в приложении — не статья.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    # Модели любят начинать с «Конечно! Вот анализ:» — это не несёт смысла
    for prefix in (
        "Конечно!", "Конечно,", "Конечно.", "Разумеется,", "Безусловно,",
        "Вот анализ:", "Вот краткий анализ:", "Анализ:", "Ответ:", "Итак,",
        "Here is", "Sure,",
    ):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):].strip()

    lines: list[str] = []
    for line in cleaned.splitlines():
        stripped = line.strip().lstrip("#>*-• ").strip()
        if stripped:
            lines.append(stripped)
    cleaned = " ".join(lines)

    cleaned = cleaned.replace("**", "").replace("__", "").replace("`", "")
    cleaned = " ".join(cleaned.split())

    if len(cleaned) > MAX_ANSWER_CHARS:
        cut = cleaned[: MAX_ANSWER_CHARS]
        for separator in (". ", "! ", "? "):
            position = cut.rfind(separator)
            if position > MAX_ANSWER_CHARS * 0.6:
                return cut[: position + 1].strip()
        return cut.strip() + "…"

    return cleaned


def _collect_numbers(value: Any, *, limit: int = 400) -> set[float]:
    """Собирает все числа из данных движка: по ним проверяем ответ модели."""
    found: set[float] = set()

    def walk(node: Any, depth: int = 0) -> None:
        if len(found) >= limit or depth > 6:
            return
        if isinstance(node, bool):
            return
        if isinstance(node, (int, float)):
            found.add(round(float(node), 2))
            return
        if isinstance(node, Mapping):
            for item in node.values():
                walk(item, depth + 1)
            return
        if isinstance(node, (list, tuple, set)):
            for item in node:
                walk(item, depth + 1)
            return

    walk(value)
    return found


# Символы, которыми в русских текстах разделяют тысячи: «8 330 ₽», «1 762,22 ₽»
THOUSAND_SPACES = re.compile(r"(?<=\d)[ \u00a0\u202f](?=\d{3}(?!\d))")


def _number_tokens(text: str) -> list[tuple[str, float]]:
    """Вытаскивает из текста «денежные» числа: с ₽, с % или большие значения.

    Первым делом склеиваем разряды: «8 330 ₽» — это одна сумма 8330 ₽,
    а не число 330 рядом со знаком рубля. Без этого шага проверка считала
    бы честную сумму выдуманной.
    """
    normalized = THOUSAND_SPACES.sub("", text or "")
    tokens: list[tuple[str, float]] = []
    buffer = ""
    for index, char in enumerate(normalized + " "):
        if char.isdigit() or (char in ".," and buffer):
            buffer += char
            continue
        if buffer:
            tail = normalized[index : index + 2]
            value = _to_number(buffer)
            if value is not None and (value >= 1000 or "%" in tail or "₽" in tail or "руб" in tail.lower()):
                tokens.append((buffer, value))
            buffer = ""
    return tokens


def _to_number(raw: str) -> float | None:
    """«1 234.5» / «1,234.50» / «1200» → число."""
    text = raw.strip().replace(" ", "").rstrip(".,")
    if not text:
        return None
    if "," in text and "." in text:
        text = text.replace(",", "")
    else:
        text = text.replace(",", ".")
    try:
        return round(float(text), 2)
    except ValueError:
        return None


def numbers_are_grounded(text: str, facts: Any, *, tolerance: float = 1.0) -> bool:
    """Проверяет, что модель не выдумала цифры.

    ИИ получает точные числа от движка. Если в ответе появилась сумма или
    процент, которых в исходных данных нет, — такой текст показывать нельзя:
    клиент увидит выдуманные деньги. В этом случае вызывающий код возьмёт
    шаблонный текст, собранный из тех же самых чисел движка.
    """
    allowed = _collect_numbers(facts)
    if not allowed:
        return True

    for raw, value in _number_tokens(text):
        if any(abs(value - known) <= tolerance for known in allowed):
            continue
        # Проценты вида «15%» могут быть округлением от 14.6 — допускаем ±1
        if any(abs(value - known) <= 1.0 for known in allowed):
            continue
        log.warning("В ответе ИИ найдено число, которого нет в расчётах", number=raw, value=value)
        return False
    return True


def summarize_models(models: Iterable[str] = FREE_MODELS) -> str:
    """Человеческое перечисление моделей — для логов и экрана настроек."""
    return ", ".join(model.split("/")[-1].replace(":free", "") for model in models)


__all__ = [
    "DEFAULT_MAX_TOKENS",
    "DEFAULT_TEMPERATURE",
    "FREE_MODELS",
    "MAX_ANSWER_CHARS",
    "OPENROUTER_URL",
    "OpenRouterClient",
    "OpenRouterError",
    "clean_answer",
    "numbers_are_grounded",
    "summarize_models",
]
