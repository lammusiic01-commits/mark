"""Проверка сайта: технические замечания, которые мешают конверсии.

Модуль работает с тем, что уже скачано (HTML и метаданные ответа) — сеть
живёт в services/hosting.py. Это позволяет проверять и сайты на Tilda, и
самописные, и проекты на Vercel: движку важен только код страницы.

Отдельная ценность для клиента: каждое замечание объясняется деньгами —
«из-за этого вы теряете примерно X% заявок» и что сделать первым.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from engine import SEVERITY_CRITICAL, SEVERITY_INFO, SEVERITY_WARNING, Finding, sort_by_impact, to_float

# Рекомендуемые длины мета-тегов (по ним Яндекс строит сниппет)
TITLE_MIN, TITLE_MAX = 30, 70
DESCRIPTION_MIN, DESCRIPTION_MAX = 70, 200

# Порог «медленной» страницы: выше — теряем часть трафика и денег
SLOW_RESPONSE_MS = 1500
VERY_SLOW_RESPONSE_MS = 3000

# Минимальный объём текста на посадочной странице
MIN_WORDS = 120

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class PageData:
    """Страница: адрес, HTML и как быстро она ответила."""

    url: str
    html: str = ""
    status_code: int = 200
    response_ms: int = 0
    content_length: int = 0
    headers: Mapping[str, str] = field(default_factory=dict)
    is_main: bool = True

    @property
    def html_lower(self) -> str:
        return self.html.lower()


@dataclass(slots=True)
class SeoResult:
    """Итог проверки: оценка, находки и технические факты."""

    score: int
    findings: list[Finding]
    facts: dict[str, Any]
    pages_checked: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "findings": [finding.to_dict() for finding in self.findings],
            "facts": self.facts,
            "pages_checked": self.pages_checked,
            "issues": len(self.findings),
        }

    @property
    def critical_count(self) -> int:
        return sum(1 for finding in self.findings if finding.severity == SEVERITY_CRITICAL)


def analyze_page(page: PageData, *, check_metrika: bool = True) -> SeoResult:
    """Проверяет одну страницу и возвращает список замечаний с оценкой.

    check_metrika — искать ли счётчик Яндекс.Метрики в коде: без него
    оптимизация рекламы слепая, поэтому это отдельное важное замечание.
    """
    findings: list[Finding] = []
    html = page.html or ""
    lower = html.lower()

    title = _extract_title(html)
    description = _extract_meta(html, "description")
    h1_list = _extract_tags(html, "h1")
    text_words = len(SPACE_RE.sub(" ", TAG_RE.sub(" ", html)).split())

    facts: dict[str, Any] = {
        "url": page.url,
        "status_code": page.status_code,
        "response_ms": page.response_ms,
        "html_bytes": len(html.encode("utf-8")) if html else 0,
        "title": title[:200],
        "title_length": len(title),
        "description": description[:300],
        "description_length": len(description),
        "h1_count": len(h1_list),
        "h1_text": (h1_list[0][:200] if h1_list else ""),
        "words": text_words,
        "has_viewport": 'name="viewport"' in lower or "name='viewport'" in lower,
        "has_canonical": "rel=\"canonical\"" in lower or "rel='canonical'" in lower,
        "has_lang": "<html" in lower and "lang=" in lower,
        "has_og": "og:title" in lower or "property=\"og:" in lower,
        "images": len(_extract_tags(html, "img", with_attrs=True)),
        "images_without_alt": _count_images_without_alt(html),
        "has_metrika": "mc.yandex.ru" in lower or "ym(" in lower,
        "has_analytics_other": "googletagmanager" in lower or "gtag(" in lower,
        "robots_noindex": "noindex" in _extract_meta(html, "robots").lower(),
        "has_schema_org": "schema.org" in lower or "application/ld+json" in lower,
    }

    # ─── Доступность и скорость ────────────────────────────────
    if page.status_code >= 400:
        findings.append(
            Finding(
                code="site:status",
                title=f"Страница отвечает ошибкой {page.status_code}",
                description=(
                    "Реклама ведёт на страницу, которая не открывается: каждый такой клик — выброшенные деньги. "
                    "Проверьте адрес в объявлениях и редиректы на сайте."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=0.0,
                action="Исправить адрес посадочной страницы в кампаниях или восстановить страницу",
            ),
        )
    elif page.response_ms >= VERY_SLOW_RESPONSE_MS:
        findings.append(
            Finding(
                code="site:slow",
                title=f"Страница открывается за {page.response_ms / 1000:.1f} с",
                description=(
                    "Медленный ответ увеличивает отказы и снижает конверсию. На платном трафике это самая "
                    "дорогая техническая проблема после недоступного сайта."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=0.0,
                action="Включить кэширование и CDN, сжать картинки, проверить хостинг",
                evidence={"response_ms": page.response_ms},
            ),
        )
    elif page.response_ms >= SLOW_RESPONSE_MS:
        findings.append(
            Finding(
                code="site:slowish",
                title=f"Страница отвечает за {page.response_ms / 1000:.1f} с",
                description="Есть запас для ускорения: быстрая страница получает больше заявок при том же бюджете.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Проверить скорость загрузки в Метрике и сжать тяжёлые изображения",
                evidence={"response_ms": page.response_ms},
            ),
        )

    # ─── Заголовок страницы ───────────────────────────────────
    if not title:
        findings.append(
            Finding(
                code="site:title-missing",
                title="Нет заголовка страницы (title)",
                description="Яндекс строит сниппет объявления и перехода из title — без него кликают меньше.",
                severity=SEVERITY_CRITICAL,
                impact_rub=0.0,
                action="Добавить title с услугой, городом и выгодой: «Ремонт кондиционеров в Москве — выезд за 2 часа»",
            ),
        )
    elif len(title) > TITLE_MAX:
        findings.append(
            Finding(
                code="site:title-long",
                title=f"Слишком длинный title ({len(title)} символов)",
                description="В сниппете видно примерно 70 символов — остальное обрезается.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Сократить title до 50–65 символов, ключевую фразу поставить в начало",
            ),
        )
    elif len(title) < TITLE_MIN:
        findings.append(
            Finding(
                code="site:title-short",
                title=f"Короткий title ({len(title)} символов)",
                description="Заголовок не объясняет предложение — сниппет выглядит неубедительно.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Дополнить title городом, услугой и отличием от конкурентов",
            ),
        )

    # ─── Описание и структура ─────────────────────────────────
    if not description:
        findings.append(
            Finding(
                code="site:description-missing",
                title="Нет описания страницы (description)",
                description="Яндекс покажет случайный текст со страницы — сниппет теряет убедительность.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Написать описание на 120–180 символов с ценой, сроком или гарантией",
            ),
        )
    elif len(description) > DESCRIPTION_MAX:
        findings.append(
            Finding(
                code="site:description-long",
                title=f"Длинное описание ({len(description)} символов)",
                description="Описание обрезается в выдаче, важная часть может не попасть в сниппет.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Сократить до 150 символов, смысл — в первом предложении",
            ),
        )

    if not h1_list:
        findings.append(
            Finding(
                code="site:h1-missing",
                title="Нет главного заголовка H1",
                description="H1 связывает страницу с запросом пользователя: его отсутствие снижает релевантность.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Добавить один H1 с главной услугой и городом",
            ),
        )
    elif len(h1_list) > 1:
        findings.append(
            Finding(
                code="site:h1-many",
                title=f"Несколько H1 на странице ({len(h1_list)})",
                description="Несколько главных заголовков размывают вес страницы — поиск не понимает главное.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Оставить один H1, остальные заменить на H2",
            ),
        )

    # ─── Мобильные и технические теги ─────────────────────────
    if not facts["has_viewport"]:
        findings.append(
            Finding(
                code="site:no-viewport",
                title="Страница не адаптируется под телефон",
                description=(
                    "Больше половины рекламного трафика — мобильный. Без meta viewport страница выглядит "
                    "уменьшенной копией, и пользователь уходит."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=0.0,
                action="Добавить <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
            ),
        )

    if facts["robots_noindex"]:
        findings.append(
            Finding(
                code="site:noindex",
                title="Страница закрыта от индексации",
                description="В robots указан noindex: страница не появится в поиске и не соберёт бесплатный трафик.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Снять noindex, если страница должна быть в поиске",
            ),
        )

    if not facts["has_lang"]:
        findings.append(
            Finding(
                code="site:no-lang",
                title="Не указан язык страницы",
                description="Атрибут lang помогает поиску понять язык и регион аудитории.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Указать <html lang=\"ru\">",
            ),
        )

    # ─── Аналитика ────────────────────────────────────────────
    if check_metrika and not facts["has_metrika"]:
        findings.append(
            Finding(
                code="site:no-metrika",
                title="На странице нет счётчика Яндекс.Метрики",
                description=(
                    "Без Метрики не видно, какие фразы приносят заявки, и движок не может оптимизировать ставки. "
                    "Это первое, что нужно включить."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=0.0,
                action="Установить счётчик Метрики и настроить цели (форма, звонок)",
            ),
        )

    # ─── Картинки и текст ─────────────────────────────────────
    images_without_alt = facts["images_without_alt"]
    if facts["images"] and images_without_alt >= max(3, facts["images"] // 2):
        findings.append(
            Finding(
                code="site:images-alt",
                title=f"У {images_without_alt} изображений нет alt",
                description="Alt-тексты помогают и поиску, и людям с ограниченным зрением — это дешёвая правка.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Заполнить alt у значимых картинок: что на них изображено",
            ),
        )

    if text_words and text_words < MIN_WORDS:
        findings.append(
            Finding(
                code="site:thin-content",
                title=f"Мало текста на странице ({text_words} слов)",
                description="Поиску и человеку не хватает информации об услуге — снижается и релевантность, и доверие.",
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Добавить блоки: цены, сроки, примеры работ, ответы на частые вопросы",
                evidence={"words": text_words},
            ),
        )

    if not facts["has_schema_org"]:
        findings.append(
            Finding(
                code="site:no-schema",
                title="Нет микроразметки (schema.org)",
                description="Разметка даёт расширенный сниппет с ценой и рейтингом — это увеличивает кликабельность.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Добавить LocalBusiness или Product разметку с ценами и отзывами",
            ),
        )

    score = _score(findings, page)
    return SeoResult(score=score, findings=sort_by_impact(findings), facts=facts, pages_checked=1)


def analyze_site(pages: Sequence[PageData], *, check_metrika: bool = True) -> SeoResult:
    """Проверяет несколько страниц: агрегирует замечания и оценку сайта.

    Дубли одинаковых проблем объединяются: пользователю важно «что делать»,
    а не 40 строк про отсутствующий alt на каждой странице.
    """
    if not pages:
        return SeoResult(
            score=0,
            findings=[
                Finding(
                    code="site:unreachable",
                    title="Сайт не ответил",
                    description="Не удалось загрузить ни одну страницу. Проверьте адрес и доступность сайта.",
                    severity=SEVERITY_CRITICAL,
                    action="Проверить адрес сайта в подключении и доступность из интернета",
                ),
            ],
            facts={},
            pages_checked=0,
        )

    merged: dict[str, Finding] = {}
    facts: dict[str, Any] = {"pages": []}
    scores: list[int] = []

    for page in pages:
        result = analyze_page(page, check_metrika=check_metrika)
        scores.append(result.score)
        facts["pages"].append(result.facts)
        for finding in result.findings:
            existing = merged.get(finding.code)
            if existing is None:
                merged[finding.code] = finding
            else:
                # Собираем список адресов, где встретилась та же проблема
                urls = list(existing.evidence.get("urls", []))
                url = result.facts.get("url")
                if url and url not in urls:
                    urls.append(url)
                merged[finding.code] = Finding(
                    code=finding.code,
                    title=finding.title,
                    description=finding.description,
                    severity=finding.severity,
                    impact_rub=max(finding.impact_rub, existing.impact_rub),
                    action=finding.action,
                    evidence={**dict(finding.evidence), "urls": urls[:10], "pages": len(urls) + 1},
                )

    main_facts = facts["pages"][0] if facts["pages"] else {}
    facts.update({key: value for key, value in main_facts.items() if key not in facts})
    findings = sort_by_impact(list(merged.values()))
    # Проблемы, найденные на нескольких страницах, считаются важнее
    findings.sort(key=lambda item: (item.evidence.get("pages", 1), item.impact_rub), reverse=True)

    average_score = int(round(sum(scores) / len(scores))) if scores else 0
    return SeoResult(score=average_score, findings=findings, facts=facts, pages_checked=len(pages))


def quick_fixes(findings: Iterable[Finding]) -> list[dict[str, Any]]:
    """Что можно исправить прямо сейчас, без разработчика — готовый чек-лист."""
    text_codes = {
        "site:title-missing", "site:title-long", "site:title-short",
        "site:description-missing", "site:description-long",
        "site:h1-missing", "site:h1-many", "site:images-alt",
    }
    dev_codes = {"site:slow", "site:slowish", "site:no-viewport", "site:no-metrika", "site:status", "site:thin-content"}

    fixes: list[dict[str, Any]] = []
    for finding in findings:
        if finding.code in text_codes:
            kind = "текст"
            who = "маркетолог или вы сами за 15 минут"
        elif finding.code in dev_codes:
            kind = "техника"
            who = "разработчик или админ сайта"
        else:
            kind = "проверка"
            who = "можно сделать самостоятельно"
        fixes.append(
            {
                "code": finding.code,
                "title": finding.title,
                "action": finding.action,
                "kind": kind,
                "who": who,
                "severity": finding.severity,
            },
        )
    return fixes


def _score(findings: Sequence[Finding], page: PageData) -> int:
    """Оценка страницы 0–100: чем больше критичных замечаний, тем ниже."""
    score = 100.0
    for finding in findings:
        if finding.severity == SEVERITY_CRITICAL:
            score -= 18
        elif finding.severity == SEVERITY_WARNING:
            score -= 8
        else:
            score -= 3
    if page.status_code >= 400:
        score = min(score, 20)
    return int(max(0, min(100, round(score))))


# ─── Разбор HTML ───────────────────────────────────────────────

def _extract_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return SPACE_RE.sub(" ", _strip_tags(match.group(1))).strip() if match else ""


def _extract_meta(html: str, name: str) -> str:
    pattern = rf"<meta[^>]+name=[\"']{name}[\"'][^>]*>"
    match = re.search(pattern, html, re.IGNORECASE)
    if not match:
        pattern = rf"<meta[^>]+property=[\"']og:{name}[\"'][^>]*>"
        match = re.search(pattern, html, re.IGNORECASE)
    if not match:
        return ""
    content = re.search(r"content=[\"'](.*?)[\"']", match.group(0), re.IGNORECASE | re.DOTALL)
    return SPACE_RE.sub(" ", content.group(1)).strip() if content else ""


def _extract_tags(html: str, tag: str, with_attrs: bool = False) -> list[str]:
    matches = re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", html, re.IGNORECASE | re.DOTALL)
    if with_attrs:
        return re.findall(rf"<{tag}[^>]*>", html, re.IGNORECASE)
    return [SPACE_RE.sub(" ", _strip_tags(item)).strip() for item in matches]


def _count_images_without_alt(html: str) -> int:
    images = re.findall(r"<img[^>]*>", html, re.IGNORECASE)
    return sum(1 for image in images if "alt=" not in image.lower())


def _strip_tags(value: str) -> str:
    return TAG_RE.sub(" ", value)


def demo_html(*, bad: bool = False) -> str:
    """Пример страницы для демонстрации и автотестов."""
    if bad:
        return (
            "<html><head><title>Главная</title></head><body>"
            "<img src='a.jpg'><img src='b.jpg'><img src='c.jpg'><img src='d.jpg'>"
            "<p>Мы работаем.</p></body></html>"
        )
    return (
        "<html lang='ru'><head>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<meta name='description' content='Ремонт кондиционеров в Москве: выезд за 2 часа, гарантия 1 год, "
        "честные цены и бесплатная диагностика при заказе работ до конца месяца.'>"
        "<title>Ремонт кондиционеров в Москве — выезд за 2 часа, гарантия 1 год</title>"
        "<link rel='canonical' href='https://example.org/'>"
        "</head><body><h1>Ремонт кондиционеров</h1>"
        + "<p>Описание услуги. Мы ремонтируем кондиционеры всех марок: цены, сроки и гарантия.</p>" * 20
        + "<script>ym(12345678, 'init', {});</script></body></html>"
    )


__all__ = [
    "MIN_WORDS",
    "SLOW_RESPONSE_MS",
    "VERY_SLOW_RESPONSE_MS",
    "PageData",
    "SeoResult",
    "analyze_page",
    "analyze_site",
    "demo_html",
    "quick_fixes",
]
