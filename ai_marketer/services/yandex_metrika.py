"""Клиент Яндекс.Метрики.

Нужен для трёх задач:
  1. дашборд — визиты, конверсии, источники, устройства;
  2. гео-анализ — срез по регионам;
  3. детектор ботов — выгрузка визитов (Logs API) с длительностью,
     глубиной просмотра и User-Agent: именно по ним видны боты.

Logs API работает асинхронно: заказ выгрузки → ожидание → скачивание частями.
Клиент делает это сам и возвращает готовый список визитов.
"""

from __future__ import annotations

import asyncio
import csv
import gzip
import io
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Mapping, Sequence

import httpx

from core.logger import get_logger
from engine import to_float

log = get_logger(__name__)

METRIKA_API_BASE = "https://api-metrika.yandex.net"

# Сколько ждём готовности выгрузки визитов (секунды)
LOG_REQUEST_TIMEOUT = 240
LOG_REQUEST_POLL_INTERVAL = 5

# Поля выгрузки визитов: полный набор — по нему видно и ботов, и рекламу.
# Названия строго из документации Logs API (уровень «Визиты»): если поле
# написано неверно, Метрика отклоняет весь запрос, поэтому список проверен
# по https://yandex.ru/dev/metrika/ru/logs/fields/visits
DEFAULT_LOG_FIELDS = (
    "ym:s:date",                 # дата визита
    "ym:s:dateTime",             # дата и время — нужен для ночной активности
    "ym:s:visitID",              # идентификатор визита
    "ym:s:visitDuration",        # время на сайте
    "ym:s:pageViews",            # глубина просмотра
    "ym:s:bounce",               # отказность по мнению Метрики
    "ym:s:isNewUser",            # первый визит посетителя
    "ym:s:isRobotPro",           # антифрод Директа (только на Метрике Про)
    "ym:s:goalsID",              # достигнутые цели
    "ym:s:lastTrafficSource",    # источник трафика
    "ym:s:lastSearchEngine",     # поисковая система / поисковая фраза
    "ym:s:lastReferalSource",    # переход с другого сайта
    "ym:s:lastDirectClickOrder", # кампания Директа
    "ym:s:lastDirectPhraseOrCond",  # фраза или условие показа
    "ym:s:regionCity",           # город визита
    "ym:s:regionCityID",         # код города (совпадает с кодами Директа)
    "ym:s:userAgent",            # браузер или бот
    "ym:s:ipAddress",            # адрес — по нему видны серии визитов
    "ym:s:startURL",             # страница входа
)

# Минимальный набор: используется, если Метрика отклонила расширенный запрос
# (старый счётчик, нет Метрики Про или поле переименовали в новой версии API).
SAFE_LOG_FIELDS = (
    "ym:s:date",
    "ym:s:visitID",
    "ym:s:visitDuration",
    "ym:s:pageViews",
    "ym:s:bounce",
    "ym:s:goalsID",
    "ym:s:lastTrafficSource",
    "ym:s:regionCityID",
    "ym:s:userAgent",
    "ym:s:ipAddress",
    "ym:s:startURL",
)

# Коды статусов, при которых имеет смысл повторить запрос с базовыми полями
LOG_FIELD_FALLBACK_CODES = (400, 422)

# Метрика «достижения любой цели» в Reporting API и её запасной вариант:
# у части счётчиков доступно только второе название.
GOAL_METRIC = "ym:s:sumGoalReachesAny"
GOAL_METRIC_FALLBACK = "ym:s:goalReachesAny"


class MetrikaError(RuntimeError):
    """Ошибка Метрики с текстом для пользователя."""

    def __init__(self, message: str, *, code: int | None = None, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail


@dataclass(slots=True)
class MetrikaClient:
    """Асинхронный клиент Метрики. Токен — OAuth из secrets.env через подключение."""

    token: str
    counter_id: int | None = None
    timeout: float = 60.0
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"OAuth {self.token}", "Content-Type": "application/json"}

    async def __aenter__(self) -> "MetrikaClient":
        self._client = httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _get(self, path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns = self._client is None
        try:
            response = await client.get(f"{METRIKA_API_BASE}{path}", params=dict(params or {}))
            return self._handle(response)
        except httpx.HTTPError as error:
            raise MetrikaError(f"Нет связи с Метрикой: {error}") from error
        finally:
            if owns:
                await client.aclose()

    async def _post(self, path: str, body: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns = self._client is None
        try:
            response = await client.post(f"{METRIKA_API_BASE}{path}", json=dict(body or {}), params=dict(params or {}))
            return self._handle(response)
        except httpx.HTTPError as error:
            raise MetrikaError(f"Нет связи с Метрикой: {error}") from error
        finally:
            if owns:
                await client.aclose()

    @staticmethod
    def _handle(response: httpx.Response) -> dict[str, Any]:
        """Разбирает ответ и ошибки с человеческим текстом."""
        try:
            data = response.json()
        except Exception:  # noqa: BLE001
            data = {}

        if response.status_code >= 400:
            message = str(data.get("message") or data.get("errors") or "Ошибка Метрики")
            hints = {
                401: "Токен Метрики недействителен — подключите счётчик заново.",
                403: "У токена нет доступа к этому счётчику — проверьте права.",
                404: "Счётчик с таким номером не найден.",
                429: "Превышен лимит запросов к Метрике — подождите минуту.",
            }
            if response.status_code in hints:
                message = f"{message}. {hints[response.status_code]}"
            raise MetrikaError(message, code=response.status_code, detail=str(data)[:300])
        return data if isinstance(data, dict) else {}

    # ─── Счётчики и цели ───────────────────────────────────────

    async def list_counters(self) -> list[dict[str, Any]]:
        """Счётчики, доступные токену: пригодятся при подключении."""
        data = await self._get("/management/v1/counters", {"per_page": 200})
        return [
            {
                "id": int(to_float(item.get("id"))),
                "name": item.get("name") or f"Счётчик {item.get('id')}",
                "site": item.get("site") or "",
                "status": item.get("status") or "",
            }
            for item in data.get("counters", [])
        ]

    async def check_token(self) -> dict[str, Any]:
        """Проверка подключения: есть ли счётчики и цели."""
        counters = await self.list_counters()
        goals = await self.list_goals(counters[0]["id"]) if counters else []
        log.info("Токен Метрики работает", counters=len(counters), goals=len(goals))
        return {"ok": True, "counters": len(counters), "goals": len(goals), "last_counter_id": counters[0]["id"] if counters else None}

    async def list_goals(self, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Цели счётчика: по ним считаются конверсии."""
        counter = counter_id or self.counter_id
        if not counter:
            raise MetrikaError("Не указан номер счётчика Метрики")
        data = await self._get(f"/management/v1/counter/{counter}/goals")
        return [
            {
                "id": int(to_float(item.get("id"))),
                "name": item.get("name") or f"Цель {item.get('id')}",
                "type": item.get("type") or "",
                "is_revenue": bool(item.get("is_revenue") or item.get("type") == "payment"),
            }
            for item in data.get("goals", [])
        ]

    # ─── Отчёты (Reporting API) ────────────────────────────────

    async def stat(
        self,
        *,
        metrics: Sequence[str],
        dimensions: Sequence[str] | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        counter_id: int | None = None,
        filters: str | None = None,
        sort: Sequence[str] | None = None,
        limit: int = 100,
        accuracy: str = "full",
    ) -> dict[str, Any]:
        """Произвольный отчёт: метрики, срезы, фильтры.

        Возвращает «сырой» ответ API: вызывающий сам решает, что из него взять.
        """
        counter = counter_id or self.counter_id
        if not counter:
            raise MetrikaError("Не указан номер счётчика Метрики")

        today = date.today()
        params: dict[str, Any] = {
            "ids": counter,
            "metrics": ",".join(metrics),
            "date1": date_from or (today - timedelta(days=29)).isoformat(),
            "date2": date_to or today.isoformat(),
            "accuracy": accuracy,
            "limit": limit,
        }
        if dimensions:
            params["dimensions"] = ",".join(dimensions)
        if filters:
            params["filters"] = filters
        if sort:
            params["sort"] = ",".join(sort)

        return await self._get("/stat/v1/data", params)

    async def _stat_with_goals(
        self,
        *,
        metrics: Sequence[str],
        dimensions: Sequence[str] | None = None,
        days: int | None = None,
        counter_id: int | None = None,
        sort: Sequence[str] | None = None,
        limit: int = 100,
    ) -> tuple[dict[str, Any], bool]:
        """Отчёт, где метрика достижений целей идёт последней.

        Возвращает (данные, есть_ли_цели). Если счётчик не знает основное
        название метрики целей, повторяем запрос с запасным, а если и он
        не подошёл — без целей вовсе: дашборд должен открыться в любом случае.
        """
        today = date.today()
        date_from = (today - timedelta(days=(days or 30) - 1)).isoformat()
        date_to = today.isoformat()
        full = list(metrics) + [GOAL_METRIC]

        try:
            data = await self.stat(
                metrics=full, dimensions=dimensions, date_from=date_from, date_to=date_to,
                counter_id=counter_id, sort=sort, limit=limit,
            )
            return data, True
        except MetrikaError as error:
            if error.code != 400:
                raise
            log.warning("Метрика не приняла метрику достижений цели — пробую запасное название", reason=str(error)[:160])

        spare = list(metrics) + [GOAL_METRIC_FALLBACK]
        try:
            data = await self.stat(
                metrics=spare, dimensions=dimensions, date_from=date_from, date_to=date_to,
                counter_id=counter_id, sort=sort, limit=limit,
            )
            return data, True
        except MetrikaError as error:
            if error.code != 400:
                raise
            log.warning("Цели недоступны — считаю отчёт без конверсий", reason=str(error)[:160])

        data = await self.stat(
            metrics=list(metrics), dimensions=dimensions, date_from=date_from, date_to=date_to,
            counter_id=counter_id, sort=sort, limit=limit,
        )
        return data, False

    async def dashboard_metrics(self, *, days: int = 30, counter_id: int | None = None) -> dict[str, Any]:
        """Сводка для дашборда: визиты, конверсии, отказы, устройства, источники."""
        data, has_goals = await self._stat_with_goals(
            metrics=["ym:s:visits", "ym:s:users", "ym:s:pageviews", "ym:s:bounceRate", "ym:s:avgVisitDurationSeconds"],
            days=days,
            counter_id=counter_id,
            limit=1,
        )
        totals = _totals(data)
        return {
            "visits": int(to_float(totals[0] if len(totals) > 0 else 0)),
            "users": int(to_float(totals[1] if len(totals) > 1 else 0)),
            "pageviews": int(to_float(totals[2] if len(totals) > 2 else 0)),
            "bounce_rate_pct": round(to_float(totals[3] if len(totals) > 3 else 0), 1),
            "avg_duration_seconds": int(to_float(totals[4] if len(totals) > 4 else 0)),
            "conversions": round(to_float(totals[5] if has_goals and len(totals) > 5 else 0), 2),
            "goals_available": has_goals,
            "days": days,
        }

    async def by_region(self, *, days: int = 30, counter_id: int | None = None, limit: int = 30) -> list[dict[str, Any]]:
        """Срез по городам — данные для гео-анализа.

        Код региона Метрики (regionCityID) — те же коды Яндекса, что в
        Директе, поэтому данные гео стыкуются без пересчёта.
        """
        data, has_goals = await self._stat_with_goals(
            metrics=["ym:s:visits", "ym:s:bounceRate"],
            dimensions=["ym:s:regionCity"],
            days=days,
            counter_id=counter_id,
            sort=["-ym:s:visits"],
            limit=limit,
        )
        rows: list[dict[str, Any]] = []
        for row in data.get("data", []):
            dimensions = row.get("dimensions", [{}])
            metrics = row.get("metrics", [])
            city = dimensions[0] if dimensions else {}
            rows.append(
                {
                    "region_name": city.get("name") or "Неизвестный регион",
                    "region_code": int(to_float(city.get("id"))) or None,
                    "visits": int(to_float(metrics[0] if len(metrics) > 0 else 0)),
                    "bounce_rate_pct": round(to_float(metrics[1] if len(metrics) > 1 else 0), 1),
                    "conversions": round(to_float(metrics[2] if has_goals and len(metrics) > 2 else 0), 2),
                },
            )
        return rows

    async def by_device(self, *, days: int = 30, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Мобильные против десктопа: влияет на решения по сайту."""
        data, has_goals = await self._stat_with_goals(
            metrics=["ym:s:visits"],
            dimensions=["ym:s:deviceCategory"],
            days=days,
            counter_id=counter_id,
            limit=10,
        )
        labels = {"1": "десктоп", "2": "смартфон", "3": "планшет", "4": "ТВ"}
        rows = []
        for row in data.get("data", []):
            dimensions = row.get("dimensions", [{}])
            metrics = row.get("metrics", [])
            code = str(dimensions[0].get("id") if dimensions else "")
            rows.append(
                {
                    "device": labels.get(code, dimensions[0].get("name", "другое") if dimensions else "другое"),
                    "visits": int(to_float(metrics[0] if len(metrics) > 0 else 0)),
                    "conversions": round(to_float(metrics[1] if has_goals and len(metrics) > 1 else 0), 2),
                },
            )
        return rows

    async def by_source(self, *, days: int = 30, counter_id: int | None = None, limit: int = 15) -> list[dict[str, Any]]:
        """Источники трафика: реклама, поиск, прямые заходы, переходы."""
        data, has_goals = await self._stat_with_goals(
            metrics=["ym:s:visits", "ym:s:bounceRate"],
            dimensions=["ym:s:lastTrafficSource"],
            days=days,
            counter_id=counter_id,
            sort=["-ym:s:visits"],
            limit=limit,
        )
        rows = []
        for row in data.get("data", []):
            dimensions = row.get("dimensions", [{}])
            metrics = row.get("metrics", [])
            rows.append(
                {
                    "source": dimensions[0].get("name", "другое") if dimensions else "другое",
                    "source_code": str(dimensions[0].get("id")) if dimensions else "",
                    "visits": int(to_float(metrics[0] if len(metrics) > 0 else 0)),
                    "bounce_rate_pct": round(to_float(metrics[1] if len(metrics) > 1 else 0), 1),
                    "conversions": round(to_float(metrics[2] if has_goals and len(metrics) > 2 else 0), 2),
                },
            )
        return rows

    async def daily_series(self, *, days: int = 30, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Визиты и конверсии по дням — график на экранах дашборда и BotShield."""
        data, has_goals = await self._stat_with_goals(
            metrics=["ym:s:visits"],
            dimensions=["ym:s:date"],
            days=days,
            counter_id=counter_id,
            sort=["ym:s:date"],
            limit=days + 5,
        )
        rows: list[dict[str, Any]] = []
        for row in data.get("data", []):
            dimensions = row.get("dimensions", [{}])
            metrics = row.get("metrics", [])
            day = dimensions[0].get("id") if dimensions else ""
            rows.append(
                {
                    "date": str(day or "")[:10],
                    "visits": int(to_float(metrics[0] if len(metrics) > 0 else 0)),
                    "conversions": round(to_float(metrics[1] if has_goals and len(metrics) > 1 else 0), 2),
                },
            )
        return rows

    # ─── Выгрузка визитов (Logs API) ───────────────────────────

    async def request_logs(
        self,
        *,
        date_from: str,
        date_to: str,
        fields: Sequence[str] = DEFAULT_LOG_FIELDS,
        source: str = "visits",
        counter_id: int | None = None,
    ) -> int:
        """Заказывает выгрузку визитов и возвращает её номер.

        Если Метрика не принимает расширенный набор полей (счётчик без
        Метрики Про, изменённые поля в новой версии API), автоматически
        повторяем запрос с базовым набором — выгрузка должна получиться
        в любом случае, пусть и с меньшим числом признаков для анализа.
        """
        counter = counter_id or self.counter_id
        if not counter:
            raise MetrikaError("Не указан номер счётчика Метрики")

        try:
            return await self._create_log_request(counter, date_from, date_to, fields, source)
        except MetrikaError as error:
            if error.code not in LOG_FIELD_FALLBACK_CODES or tuple(fields) == SAFE_LOG_FIELDS:
                raise
            log.warning("Метрика отклонила расширенные поля выгрузки — беру базовый набор", reason=str(error)[:160])
            return await self._create_log_request(counter, date_from, date_to, SAFE_LOG_FIELDS, source)

    async def _create_log_request(
        self,
        counter: int,
        date_from: str,
        date_to: str,
        fields: Sequence[str],
        source: str,
    ) -> int:
        """Одна попытка заказать выгрузку с заданным набором полей."""
        body = {
            "date1": date_from,
            "date2": date_to,
            "fields": list(fields),
            "source": source,
            "attribution": "last",
        }
        data = await self._post(f"/management/v1/counter/{counter}/logrequests", body)
        request = data.get("log_request", {})
        request_id = int(to_float(request.get("request_id")))
        if not request_id:
            raise MetrikaError("Метрика не приняла запрос на выгрузку визитов", detail=str(data)[:200])
        log.info("Выгрузка визитов заказана", counter=counter, request_id=request_id, fields=len(fields))
        return request_id

    async def wait_for_logs(self, request_id: int, *, counter_id: int | None = None, timeout: int = LOG_REQUEST_TIMEOUT) -> str:
        """Ждёт готовности выгрузки и возвращает статус (processed | failed | ...)."""
        counter = counter_id or self.counter_id
        if not counter:
            raise MetrikaError("Не указан номер счётчика Метрики")

        started = asyncio.get_event_loop().time()
        while True:
            data = await self._get(f"/management/v1/counter/{counter}/logrequest/{request_id}")
            request = data.get("log_request", {})
            status = str(request.get("status") or "").lower()
            if status == "processed":
                return status
            if status in {"failed", "cleaned"}:
                raise MetrikaError(f"Метрика не смогла собрать выгрузку (статус {status})")
            if asyncio.get_event_loop().time() - started > timeout:
                raise MetrikaError("Выгрузка визитов готовится слишком долго — попробуйте меньший период")
            await asyncio.sleep(LOG_REQUEST_POLL_INTERVAL)

    async def download_logs(self, request_id: int, *, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Скачивает все части выгрузки и разбирает их в список записей."""
        counter = counter_id or self.counter_id
        if not counter:
            raise MetrikaError("Не указан номер счётчика Метрики")

        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns = self._client is None
        rows: list[dict[str, Any]] = []
        headers: list[str] = []
        try:
            part = 0
            empty_streak = 0
            while part < 100:  # защита от бесконечного цикла
                response = await client.get(
                    f"{METRIKA_API_BASE}/management/v1/counter/{counter}/logrequest/{request_id}/part/{part}/download",
                )
                if response.status_code in (204, 404):
                    empty_streak += 1
                    if empty_streak >= 3:
                        break
                    part += 1
                    continue
                if response.status_code >= 400:
                    raise MetrikaError(f"Не удалось скачать выгрузку (код {response.status_code})", code=response.status_code)
                content = response.content
                if content[:2] == b"\x1f\x8b":  # gzip
                    content = gzip.decompress(content)
                text = content.decode("utf-8", errors="replace")
                parsed = _parse_tsv(text)
                if parsed:
                    if not headers:
                        headers = list(parsed[0].keys())
                    rows.extend(parsed)
                empty_streak = 0
                part += 1
        finally:
            if owns:
                await client.aclose()

        log.info("Выгрузка визитов получена", rows=len(rows), parts=part)
        return rows

    async def visits(self, *, date_from: str, date_to: str, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Полный цикл: заказ → ожидание → скачивание. Удобно вызывать из движка."""
        request_id = await self.request_logs(date_from=date_from, date_to=date_to, counter_id=counter_id)
        await self.wait_for_logs(request_id, counter_id=counter_id)
        raw = await self.download_logs(request_id, counter_id=counter_id)
        return normalize_visits(raw)


def normalize_visits(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Приводит выгрузку Метрики к формату движка (Visit из bot_detector).

    Метрика отдаёт поля с префиксами ym:s: — убираем их и переводим значения
    к удобным типам. Конверсии считаем по достигнутым целям (поле goalsID),
    отказность берём из Метрики, когда она есть, и считаем сами, когда нет.
    """
    visits: list[dict[str, Any]] = []
    for row in rows:
        flat = {_strip_prefix(key): value for key, value in row.items()}
        duration = int(to_float(flat.get("visitDuration")))
        page_views = int(to_float(flat.get("pageViews")))
        bounce_flag = flat.get("bounce")

        visits.append(
            {
                "visit_id": str(flat.get("visitID") or ""),
                "date": _date_only(flat.get("date") or flat.get("dateTime")),
                "duration_seconds": duration,
                "page_views": page_views,
                # Отказность Метрики точнее нашей догадки; если поля нет —
                # считаем отказом короткий визит с одной страницей.
                "is_bounce": bool(to_float(bounce_flag)) if bounce_flag not in (None, "") else (duration <= 3 and page_views <= 1),
                "source": _source_code(flat),
                "user_agent": flat.get("userAgent") or "",
                "ip": flat.get("ipAddress") or None,
                "region_code": int(to_float(flat.get("regionCityID") or flat.get("regionCity"))) or None,
                "region_name": flat.get("regionCity") or None,
                "conversions": _array_len(flat.get("goalsID")),
                "search_phrase": flat.get("lastSearchEngine") or flat.get("searchEngine") or None,
                "campaign_id": str(flat.get("lastDirectClickOrder")) if flat.get("lastDirectClickOrder") else None,
                "hour": _hour_of(flat.get("dateTime")),
                # Антифрод Директа: 1 — Метрика сама считает визит роботным
                "is_robot_pro": to_float(flat.get("isRobotPro")) == 1,
            },
        )
    return visits


def _strip_prefix(key: str) -> str:
    """ym:s:visitDuration → visitDuration, ym:s:lastTrafficSource → lastTrafficSource."""
    text = str(key).strip()
    if text.startswith("ym:s:"):
        return text[5:]
    if text.startswith("ym:h:"):
        return text[5:]
    parts = text.split(":")
    return parts[-1] if parts else text


def _hour_of(value: Any) -> int | None:
    """Вытаскивает час из «2026-09-20 03:14:07» и «2026-09-20T03:14:07»."""
    text = str(value or "").strip()
    if len(text) < 13:
        return None
    time_part = text.split(" ")[-1] if " " in text else text.split("T")[-1]
    try:
        hour = int(time_part.split(":")[0])
    except (ValueError, IndexError):
        return None
    return hour if 0 <= hour <= 23 else None


def _date_only(value: Any) -> str:
    """Оставляет только дату: из «2026-09-20 03:14:07» делает «2026-09-20»."""
    text = str(value or "").strip()
    if not text:
        return ""
    if "T" in text:
        return text.split("T")[0]
    if " " in text:
        return text.split(" ")[0]
    return text[:10]


def _array_len(value: Any) -> int:
    """Считает элементы поля-массива Метрики: «[123,456]» → 2, «0» → 0.

    Метрика отдаёт массивы в виде [1,2,3], поэтому длину берём по запятым,
    а не по числу: иначе «[123]» превратилось бы в одно достижение цели.
    """
    text = str(value or "").strip()
    if not text or text in {"[]", "0", "none", "null"}:
        return 0
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        return len([part for part in inner.split(",") if part.strip()]) if inner else 0
    return 1 if to_float(text) > 0 else 0


def _source_code(flat: Mapping[str, Any]) -> str:
    """Определяет источник визита по данным Метрики."""
    source = str(flat.get("lastTrafficSource") or flat.get("trafficSource") or "").lower()
    if source in {"ad", "recommend"}:
        return "ad"
    search = str(flat.get("lastSearchEngine") or flat.get("searchEngine") or "").lower()
    if search and search not in {"none", ""}:
        return "organic"
    if str(flat.get("lastReferalSource") or flat.get("referalSource") or "").strip() not in {"", "none"}:
        return "referral"
    return "direct"


def _parse_tsv(text: str) -> list[dict[str, Any]]:
    """Разбирает TSV-выгрузку Метрики в список словарей."""
    if not text.strip():
        return []
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    rows = list(reader)
    if not rows:
        return []
    headers = [header.strip() for header in rows[0]]
    result: list[dict[str, Any]] = []
    for row in rows[1:]:
        if not row or len(row) < len(headers):
            continue
        result.append({headers[index]: value for index, value in enumerate(row)})
    return result


def _totals(data: Mapping[str, Any]) -> list[float]:
    """Достаёт значения метрик из ответа Reporting API."""
    rows = data.get("data") or []
    if not rows:
        return []
    return [to_float(value) for value in rows[0].get("metrics", [])]


async def build_client(token: str, counter_id: int | None = None) -> MetrikaClient:
    """Создаёт готовый клиент Метрики."""
    client = MetrikaClient(token=token, counter_id=counter_id)
    client._client = httpx.AsyncClient(timeout=client.timeout, headers=client._headers())  # noqa: SLF001 — фабрика внутри модуля
    return client


__all__ = [
    "DEFAULT_LOG_FIELDS",
    "GOAL_METRIC",
    "GOAL_METRIC_FALLBACK",
    "LOG_FIELD_FALLBACK_CODES",
    "METRIKA_API_BASE",
    "MetrikaClient",
    "MetrikaError",
    "SAFE_LOG_FIELDS",
    "build_client",
    "log_request_fields",
    "normalize_visits",
]


def log_request_fields(advanced: bool = True) -> tuple[str, ...]:
    """Набор полей для выгрузки визитов: полный или базовый."""
    return DEFAULT_LOG_FIELDS if advanced else SAFE_LOG_FIELDS
