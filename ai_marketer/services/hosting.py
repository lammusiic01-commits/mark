"""Работа с сайтом клиента: загрузка страниц и определение платформы.

Требование продукта: подключаться к сайту на любой платформе — Tilda, WordPress,
Bitrix, Vercel, Netlify, самописный проект. Поэтому модуль работает с обычным
HTTP-ответом и не требует ни CMS-плагинов, ни доступов к админке.

Что умеет:
  • скачать страницу и измерить время ответа (для SEO-проверки);
  • определить платформу и хостинг по коду и заголовкам;
  • проверить HTTPS, robots.txt, sitemap.xml и DNS;
  • собрать «паспорт сайта» для экрана подключения.
"""

from __future__ import annotations

import asyncio
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse, urlunparse

import httpx

from core.logger import get_logger
from engine.seo_analyzer import PageData

log = get_logger(__name__)

# Представляемся как обычный браузер: некоторые площадки закрывают доступ ботам
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 AI-Marketer-Check/1.0"
)

DEFAULT_TIMEOUT = 20.0
MAX_HTML_BYTES = 3 * 1024 * 1024  # 3 МБ — больше для анализа не нужно

# Признаки платформ: ищем в HTML и заголовках.
# Порядок важен — он же приоритет. Сначала конструкторы (по ним видно, где
# клиент правит сайт), потом фреймворки, и лишь в конце хостинги: проект на
# Next.js живёт на Vercel, но подсказку человеку нужно дать про Next.js.
PLATFORM_SIGNS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Tilda", "Tilda Publishing", ("tilda", "t-body", "t-records", "static.tildacdn.com")),
    ("WordPress", "WordPress", ("wp-content", "wp-includes", "wordpress", "woocommerce")),
    ("Битрикс", "1С-Битрикс", ("bitrix", "b24-", "bx-", "bitrix24")),
    ("Webflow", "Webflow", ("webflow", "w-nav", "w-layout")),
    ("Wix", "Wix", ("wix.com", "wixstatic", "wixsite")),
    ("Craftum", "Craftum", ("craftum",)),
    ("Nethouse", "Nethouse", ("nethouse",)),
    ("Taplink", "Taplink / визитка", ("taplink", "taplink.cc")),
    ("MODX", "MODX", ("modx", "assets/components/")),
    ("OpenCart", "OpenCart", ("opencart", "index.php?route=")),
    ("Joomla", "Joomla", ("/media/jui/", "joomla")),
    ("Nuxt", "Nuxt", ("__nuxt", "_nuxt/")),
    ("Next.js", "Next.js", ("__next", "_next/")),
    ("Vue", "Vue SPA", ("data-v-", "__vue__", "vue.js")),
    ("React", "React SPA", ("data-reactroot", "react-dom", "root-render")),
    ("Vercel", "Vercel", ("x-vercel", "vercel.app")),
    ("Netlify", "Netlify", ("netlify", "x-nf-request-id")),
)

# Признаки хостинга по заголовкам ответа
HOSTING_SIGNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Cloudflare", ("cf-ray", "cf-cache-status")),
    ("Vercel", ("x-vercel-id", "server: vercel")),
    ("Netlify", ("x-nf-request-id", "server: netlify")),
    ("GitHub Pages", ("server: github.com", "x-github-request-id")),
    ("Timeweb", ("timeweb",)),
    ("Reg.ru", ("reg.ru", "hosting.reg.ru")),
    ("Beget", ("beget",)),
    ("Selectel", ("selectel",)),
    ("Яндекс Облако", ("yandex",)),
    ("Nginx", ("nginx",)),
    ("Apache", ("apache",)),
)


class SiteError(RuntimeError):
    """Проблема с сайтом: понятный текст вместо ошибки сети."""


@dataclass(slots=True)
class SitePassport:
    """Паспорт сайта: что за платформа, работает ли HTTPS, что с robots и картой."""

    url: str
    domain: str
    ok: bool
    status_code: int = 0
    response_ms: int = 0
    platform: str = "не определена"
    platform_title: str = ""
    hosting: str = "не определён"
    server: str = ""
    https: bool = False
    ssl_days_left: int | None = None
    has_robots: bool = False
    has_sitemap: bool = False
    has_metrika: bool = False
    has_analytics: bool = False
    is_mobile_friendly: bool = False
    redirects_to: str | None = None
    ip: str | None = None
    notes: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "domain": self.domain,
            "ok": self.ok,
            "status_code": self.status_code,
            "response_ms": self.response_ms,
            "platform": self.platform,
            "platform_title": self.platform_title,
            "hosting": self.hosting,
            "server": self.server,
            "https": self.https,
            "ssl_days_left": self.ssl_days_left,
            "has_robots": self.has_robots,
            "has_sitemap": self.has_sitemap,
            "has_metrika": self.has_metrika,
            "has_analytics": self.has_analytics,
            "is_mobile_friendly": self.is_mobile_friendly,
            "redirects_to": self.redirects_to,
            "ip": self.ip,
            "notes": self.notes,
            "error": self.error,
        }


def normalize_url(url: str) -> str:
    """Приводит адрес к рабочему виду: без пробелов, со схемой, без хвостового слэша-дубля."""
    raw = (url or "").strip().replace(" ", "")
    if not raw:
        raise SiteError("Пустой адрес сайта")
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    if not parsed.netloc:
        raise SiteError(f"Не похоже на адрес сайта: {url}")
    path = parsed.path or "/"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", parsed.query, ""))


def domain_of(url: str) -> str:
    """Домен без www — по нему ищем в поиске и в Метрике."""
    netloc = urlparse(normalize_url(url)).netloc.lower()
    return netloc[4:] if netloc.startswith("www.") else netloc


def detect_platform(html: str, headers: Mapping[str, str] | None = None) -> tuple[str, str]:
    """Определяет платформу сайта. Возвращает (код, человеческое название)."""
    haystack = (html or "").lower()
    header_text = " ".join(f"{key}: {value}" for key, value in (headers or {}).items()).lower()
    for code, title, signs in PLATFORM_SIGNS:
        if any(sign in haystack or sign in header_text for sign in signs):
            return code, title
    if "<html" in haystack:
        return "статика", "Статичный сайт"
    return "не определена", ""


def detect_hosting(headers: Mapping[str, str] | None = None) -> tuple[str, str]:
    """Определяет хостинг и сервер по заголовкам ответа."""
    text = " ".join(f"{key}: {value}" for key, value in (headers or {}).items()).lower()
    hosting = "не определён"
    for code, signs in HOSTING_SIGNS:
        if any(sign in text for sign in signs):
            hosting = code
            break
    server = ""
    for key, value in (headers or {}).items():
        if key.lower() == "server":
            server = value
            break
    return hosting, server


async def fetch_page(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    follow_redirects: bool = True,
    max_bytes: int = MAX_HTML_BYTES,
) -> tuple[PageData, httpx.Response | None]:
    """Скачивает страницу и замеряет время ответа.

    Возвращает PageData (его понимает SEO-анализатор) и сам ответ — из него
    берём заголовки, чтобы понять платформу и хостинг.
    """
    target = normalize_url(url)
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=follow_redirects,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "ru-RU,ru;q=0.9"},
        ) as client:
            response = await client.get(target)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            content = response.content[:max_bytes]
            html = content.decode(response.encoding or "utf-8", errors="replace")
            page = PageData(
                url=str(response.url),
                html=html,
                status_code=response.status_code,
                response_ms=elapsed_ms,
                content_length=len(content),
                headers={key.lower(): value for key, value in response.headers.items()},
                is_main=target.rstrip("/") == str(response.url).rstrip("/"),
            )
            return page, response
    except httpx.HTTPError as error:
        raise SiteError(f"Сайт не ответил: {error}") from error


async def fetch_paths(base_url: str, paths: Sequence[str], *, timeout: float = 10.0) -> dict[str, bool]:
    """Проверяет наличие служебных файлов (robots.txt, sitemap.xml, favicon)."""
    parsed = urlparse(normalize_url(base_url))
    root = f"{parsed.scheme}://{parsed.netloc}"
    result: dict[str, bool] = {}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}) as client:
        for path in paths:
            try:
                response = await client.get(f"{root}{path}")
                result[path] = response.status_code < 400 and bool(response.content)
            except httpx.HTTPError:
                result[path] = False
    return result


def check_ssl(host: str, *, timeout: float = 8.0) -> int | None:
    """Сколько дней осталось сертификату HTTPS. None — узнать не удалось.

    Просроченный сертификат — частая причина, по которой реклама льёт
    в закрытую страницу, поэтому это отдельный пункт паспорта сайта.
    """
    context = ssl.create_default_context()
    try:
        with socket.create_connection((host, 443), timeout=timeout) as sock:
            with context.wrap_socket(sock, server_hostname=host) as secured:
                certificate = secured.getpeercert() or {}
    except (OSError, ssl.SSLError) as error:
        log.warning("Не удалось проверить сертификат", host=host, error=str(error))
        return None

    not_after = certificate.get("notAfter")
    if not not_after:
        return None
    try:
        expiry = ssl.cert_time_to_seconds(not_after)
    except ValueError:
        return None

    return int((expiry - time.time()) / 86400)


async def resolve_ip(host: str) -> str | None:
    """IP-адрес сайта: помогает увидеть, отдаёт ли домен разные ответы."""
    loop = asyncio.get_event_loop()
    try:
        infos = await loop.run_in_executor(None, lambda: socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP))
    except OSError:
        return None
    return infos[0][4][0] if infos else None


async def build_passport(url: str, *, check_ssl_certificate: bool = True) -> SitePassport:
    """Собирает паспорт сайта: платформа, хостинг, HTTPS, robots, цели.

    Используется на экране подключения: пользователь видит, что мы поняли
    про его сайт, ещё до того как добавил счётчик.
    """
    try:
        target = normalize_url(url)
    except SiteError as error:
        return SitePassport(url=url, domain=url, ok=False, error=str(error))

    domain = domain_of(target)
    passport = SitePassport(url=target, domain=domain, ok=False)

    try:
        page, response = await fetch_page(target)
    except SiteError as error:
        passport.error = str(error)
        passport.notes.append("Сайт не ответил — проверьте адрес и доступность из интернета")
        return passport

    headers = {key.lower(): value for key, value in (response.headers.items() if response else [])}
    passport.status_code = page.status_code
    passport.response_ms = page.response_ms
    passport.platform, passport.platform_title = detect_platform(page.html, headers)
    passport.hosting, passport.server = detect_hosting(headers)
    passport.https = urlparse(page.url).scheme == "https"
    passport.ok = page.status_code < 400
    passport.redirects_to = page.url if page.url.rstrip("/") != target.rstrip("/") else None
    passport.has_metrika = "mc.yandex.ru" in page.html.lower() or "ym(" in page.html.lower()
    passport.has_analytics = "googletagmanager" in page.html.lower() or "gtag(" in page.html.lower() or passport.has_metrika
    passport.is_mobile_friendly = "name=\"viewport\"" in page.html.lower() or "name='viewport'" in page.html.lower()

    files = await fetch_paths(target, ["/robots.txt", "/sitemap.xml"])
    passport.has_robots = files.get("/robots.txt", False)
    passport.has_sitemap = files.get("/sitemap.xml", False)
    passport.ip = await resolve_ip(domain)

    if check_ssl_certificate and passport.https:
        passport.ssl_days_left = await asyncio.to_thread(check_ssl, domain)

    # Подсказки для человека — простыми словами
    if not passport.has_metrika:
        passport.notes.append("Счётчик Яндекс.Метрики не найден — без него не видно, какие фразы приносят заявки")
    if not passport.has_sitemap:
        passport.notes.append("Нет sitemap.xml — поиск медленнее узнаёт о новых страницах")
    if not passport.is_mobile_friendly:
        passport.notes.append("Страница может плохо выглядеть на телефоне — а это больше половины трафика")
    if passport.ssl_days_left is not None and passport.ssl_days_left < 14:
        passport.notes.append(f"Сертификат HTTPS истекает через {passport.ssl_days_left} дн. — продлите заранее")
    if passport.platform in {"Tilda", "WordPress", "Битрикс", "Webflow", "Wix", "Craftum", "Nethouse"}:
        passport.notes.append(f"Платформа определена: {passport.platform_title} — правки мета-тегов делаются в её панели")

    log.info(
        "Паспорт сайта собран",
        domain=domain,
        platform=passport.platform,
        hosting=passport.hosting,
        status=passport.status_code,
    )
    return passport


def guess_platform_hint(platform: str) -> str:
    """Как править мета-теги на конкретной платформе — короткая подсказка."""
    hints = {
        "Tilda": "В Tilda: Настройки страницы → SEO → заголовок и описание. Для всего сайта — Настройки сайта → SEO.",
        "WordPress": "В WordPress: плагин Yoast SEO или Rank Math → вкладка «SEO» у страницы.",
        "Битрикс": "В Битриксе: у страницы → вкладка «SEO» → свойства title/description, либо в шаблоне компонента.",
        "Vercel": "Проект на Vercel: мета-теги в коде страницы (next/head или index.html в public/).",
        "Netlify": "Проект на Netlify: мета-теги в index.html или в шаблоне генератора статики.",
        "Webflow": "В Webflow: Page Settings → SEO Settings (title, description, OG).",
        "Wix": "В Wix: меню страницы → SEO Basics → заголовок и описание.",
        "MODX": "В MODX: у ресурса → вкладка «Настройки» → TV-параметры title/description.",
        "OpenCart": "В OpenCart: Каталог → Товары/Категории → вкладка SEO.",
        "Nuxt": "Nuxt: useHead() или nuxt.config для дефолтных мета-тегов.",
        "Next.js": "Next.js: metadata в app/ или <Head> в pages/.",
        "статика": "Статичный сайт: правьте <title> и <meta name=\"description\"> в самом HTML-файле.",
    }
    return hints.get(platform, "Мета-теги правятся в панели вашей платформы или напрямую в HTML страницы.")


def extract_links(html: str, base_url: str, *, limit: int = 20) -> list[str]:
    """Собирает внутренние ссылки страницы — для проверки нескольких страниц."""
    parsed = urlparse(base_url)
    found: list[str] = []
    for match in re.findall(r'href=["\'](.*?)["\']', html or "", re.IGNORECASE):
        href = match.strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        if href.startswith("//"):
            href = f"{parsed.scheme}:{href}"
        elif href.startswith("/"):
            href = f"{parsed.scheme}://{parsed.netloc}{href}"
        elif not href.startswith("http"):
            continue
        if urlparse(href).netloc == parsed.netloc and href not in found:
            found.append(href)
        if len(found) >= limit:
            break
    return found


__all__ = [
    "DEFAULT_TIMEOUT",
    "HOSTING_SIGNS",
    "PLATFORM_SIGNS",
    "SiteError",
    "SitePassport",
    "USER_AGENT",
    "build_passport",
    "check_ssl",
    "detect_hosting",
    "detect_platform",
    "domain_of",
    "extract_links",
    "fetch_page",
    "fetch_paths",
    "guess_platform_hint",
    "normalize_url",
    "resolve_ip",
]
