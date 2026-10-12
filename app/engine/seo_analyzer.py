"""
SEO-аудит HTML-страницы (stdlib html.parser, без внешних зависимостей) и загрузка страницы.
"""
import re
from html.parser import HTMLParser

import aiohttp

from app.services.url_guard import assert_public_url

USER_AGENT = "Mozilla/5.0 (compatible; AIMarketerBot/4.0; +https://t.me)"
MAX_BYTES = 2 * 1024 * 1024


class _Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = False
        self.meta: dict[str, str] = {}
        self.h1_count = 0
        self.img_total = 0
        self.img_no_alt = 0
        self.html_lang = ""
        self.canonical = ""
        self.links = 0
        self.text_parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html":
            self.html_lang = a.get("lang", "")
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key:
                self.meta[key] = a.get("content", "")
        elif tag == "h1":
            self.h1_count += 1
        elif tag == "img":
            self.img_total += 1
            if not a.get("alt", "").strip():
                self.img_no_alt += 1
        elif tag == "link" and a.get("rel", "").lower() == "canonical":
            self.canonical = a.get("href", "")
        elif tag == "a" and a.get("href"):
            self.links += 1
        elif tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.text_parts.append(data)


def extract_basics(html: str) -> dict:
    parser = _Page()
    parser.feed(html)
    text = re.sub(r"\s+", " ", " ".join(parser.text_parts)).strip()
    return {
        "title": parser.title.strip(),
        "description": parser.meta.get("description", "").strip(),
        "h1_count": parser.h1_count,
        "img_total": parser.img_total,
        "img_no_alt": parser.img_no_alt,
        "html_lang": parser.html_lang,
        "canonical": parser.canonical,
        "has_viewport": "viewport" in parser.meta,
        "og_title": parser.meta.get("og:title", ""),
        "og_description": parser.meta.get("og:description", ""),
        "links": parser.links,
        "word_count": len(text.split()),
        "text": text,
    }


def audit(html: str, url: str) -> dict:
    b = extract_basics(html)
    issues: list[dict] = []
    score = 100

    def add(severity: str, message: str, penalty: int) -> None:
        nonlocal score
        issues.append({"severity": severity, "message": message})
        score -= penalty

    t = len(b["title"])
    if t == 0:
        add("error", "Нет тега <title>", 15)
    elif t < 30 or t > 60:
        add("warning", f"Длина title {t} симв. (рекомендуется 30–60)", 5)

    d = len(b["description"])
    if d == 0:
        add("error", "Нет meta description", 12)
    elif d < 50 or d > 160:
        add("warning", f"Длина description {d} симв. (рекомендуется 50–160)", 4)

    if b["h1_count"] == 0:
        add("error", "Нет заголовка H1", 12)
    elif b["h1_count"] > 1:
        add("warning", f"Несколько H1 ({b['h1_count']}), оставь один", 5)

    if b["img_no_alt"]:
        add("warning", f"Картинок без alt: {b['img_no_alt']} из {b['img_total']}", min(10, b["img_no_alt"]))

    if not b["html_lang"]:
        add("warning", "Не указан атрибут lang у <html>", 3)
    if not b["has_viewport"]:
        add("error", "Нет meta viewport: страница не адаптирована под телефон", 12)
    if not b["canonical"]:
        add("info", "Не задан canonical", 2)
    if not b["og_title"]:
        add("info", "Нет Open Graph (og:title) для превью в соцсетях", 2)
    if b["word_count"] < 300:
        add("warning", f"Мало текста: {b['word_count']} слов (ориентир 300+)", 6)

    return {
        "url": url,
        "score": max(0, score),
        "issues": issues,
        "facts": {k: v for k, v in b.items() if k != "text"},
    }


async def fetch_html(url: str, timeout: int = 15) -> tuple[int, str, int]:
    """Возвращает (status, html, elapsed_ms). URL предварительно проверяется на SSRF."""
    import time

    safe = await assert_public_url(url)
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.8"}
    start = time.monotonic()
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(safe, timeout=aiohttp.ClientTimeout(total=timeout),
                               allow_redirects=True) as resp:
            raw = await resp.content.read(MAX_BYTES)
            encoding = resp.charset or "utf-8"
            html = raw.decode(encoding, errors="replace")
            elapsed = int((time.monotonic() - start) * 1000)
            return resp.status, html, elapsed
