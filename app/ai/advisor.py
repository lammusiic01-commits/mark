"""
Советник. Сначала всегда формируется СКРИПТОВЫЙ разбор (правила движков),
затем, если включён AI и есть ключ, добавляется комментарий модели.
"""
import json
import logging

from app.ai.client import AIError, chat
from app.config import settings

log = logging.getLogger("app.ai")

SYSTEM_PROMPT = (
    "Ты маркетолог контекстной рекламы Яндекс Директ. Тебе дана сводка по данным, "
    "уже посчитанным скриптом. Не пересчитывай цифры. Дай 3 коротких практичных совета "
    "на русском языке, без эмодзи, без воды."
)


def script_advice(summary: dict, recommendations: list[dict], bot_risk: dict, funnel: dict) -> list[str]:
    tips: list[str] = []
    if summary["cpa_kop"] is not None:
        tips.append(f"Текущий CPA: {summary['cpa_kop'] / 100:.0f} ₽, CTR: {summary['ctr']}%")
    tips.append(funnel["advice"])
    if bot_risk["risk_count"]:
        tips.append(f"Проверь кампании с риском накрутки, потенциально потрачено "
                    f"{bot_risk['wasted_kop'] / 100:.0f} ₽")
    for r in recommendations:
        if r["action"] != "keep":
            tips.append(f"{r['name']}: {r['reason']}")
    if len(tips) == 0:
        tips.append("Данных мало: синхронизируй кампании и накопи хотя бы 14 дней статистики")
    return tips


async def ai_comment(summary: dict, recommendations: list[dict], api_key: str) -> str:
    payload = {
        "summary": summary,
        "recommendations": [{k: r[k] for k in ("name", "action", "reason")} for r in recommendations],
    }
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    return await chat(messages, api_key=api_key, model=settings.AI_MODEL)


async def build_advice(summary: dict, recommendations: list[dict], bot_risk: dict,
                       funnel: dict, api_key: str | None, use_ai: bool) -> dict:
    tips = script_advice(summary, recommendations, bot_risk, funnel)
    ai_text, ai_error = None, None
    if use_ai and api_key:
        try:
            ai_text = await ai_comment(summary, recommendations, api_key)
        except AIError as e:
            ai_error = str(e)
            log.warning("AI недоступен: %s", e)
    return {"script": tips, "ai": ai_text, "ai_error": ai_error, "ai_used": ai_text is not None}
