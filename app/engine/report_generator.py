"""Сборка отчёта: KPI с дельтой к прошлому периоду и разделы с рекомендациями. Чистая логика."""
from datetime import datetime


def _delta(current: float, previous: float) -> float | None:
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


def build(days: int, summary: dict, prev_summary: dict, bot_risk: dict,
          recommendations: list[dict], funnel: dict) -> dict:
    kpis = [
        {"label": "Расход", "value": round(summary["cost_kop"] / 100, 2), "unit": "₽",
         "delta": _delta(summary["cost_kop"], prev_summary["cost_kop"])},
        {"label": "Клики", "value": summary["clicks"], "unit": "",
         "delta": _delta(summary["clicks"], prev_summary["clicks"])},
        {"label": "CTR", "value": summary["ctr"], "unit": "%",
         "delta": _delta(summary["ctr"], prev_summary["ctr"])},
        {"label": "Конверсии", "value": summary["conversions"], "unit": "",
         "delta": _delta(summary["conversions"], prev_summary["conversions"])},
        {"label": "CPA", "value": round(summary["cpa_kop"] / 100, 2) if summary["cpa_kop"] else None,
         "unit": "₽", "delta": _delta(summary["cpa_kop"] or 0, prev_summary["cpa_kop"] or 0)},
    ]

    traffic_bullets = [
        f"Потрачено {summary['cost_kop'] / 100:.0f} ₽, кликов {summary['clicks']}, конверсий {summary['conversions']}",
    ]
    if summary["cpa_kop"]:
        traffic_bullets.append(f"Стоимость конверсии (CPA): {summary['cpa_kop'] / 100:.0f} ₽")
    else:
        traffic_bullets.append("Конверсий за период нет: проверь цели Метрики и посадочные страницы")

    risk_bullets = (
        [f"Кампаний с риском накрутки: {bot_risk['risk_count']}",
         f"Расход под подозрением: {bot_risk['wasted_kop'] / 100:.0f} ₽"]
        if bot_risk["risk_count"] else ["Признаков накрутки не найдено"]
    )

    rec_bullets = [f"{r['name']}: {r['reason']}" for r in recommendations if r["action"] != "keep"]
    if not rec_bullets:
        rec_bullets = ["Критичных изменений ставок не требуется"]

    return {
        "period_days": days,
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "kpis": kpis,
        "sections": [
            {"title": "Трафик и расход", "bullets": traffic_bullets},
            {"title": "Воронка", "bullets": [funnel["advice"]]},
            {"title": "Защита от накрутки", "bullets": risk_bullets},
            {"title": "Рекомендации по ставкам", "bullets": rec_bullets},
        ],
    }
