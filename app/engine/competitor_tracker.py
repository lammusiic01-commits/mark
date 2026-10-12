"""Мониторинг конкурентов: статус страницы, заголовок и отпечаток содержимого."""
import hashlib
from datetime import datetime

from app.engine.seo_analyzer import extract_basics, fetch_html
from app.models import Competitor, utcnow


def content_fingerprint(text: str) -> str:
    normalized = " ".join(text.lower().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def check_competitor(comp: Competitor) -> dict:
    """Обновляет поля конкурента in-place. Возвращает краткий результат проверки."""
    try:
        status, html, _ms = await fetch_html(comp.url)
    except Exception as e:  # сеть, таймаут, SSRF — фиксируем как статус 0
        comp.last_status = 0
        comp.changed = False
        comp.last_checked_at = utcnow()
        return {"ok": False, "status": 0, "error": str(e)}

    basics = extract_basics(html)
    new_hash = content_fingerprint(basics["text"])
    changed = bool(comp.content_hash) and comp.content_hash != new_hash
    comp.last_status = status
    comp.last_title = basics["title"][:512]
    comp.changed = changed
    comp.content_hash = new_hash
    comp.last_checked_at = utcnow()
    return {"ok": 200 <= status < 400, "status": status, "changed": changed,
            "title": basics["title"], "checked_at": comp.last_checked_at.isoformat()}


def serialize(comp: Competitor) -> dict:
    checked: datetime | None = comp.last_checked_at
    return {
        "id": comp.id,
        "name": comp.name,
        "url": comp.url,
        "last_title": comp.last_title,
        "last_status": comp.last_status,
        "changed": comp.changed,
        "last_checked_at": checked.isoformat() if checked else None,
    }
