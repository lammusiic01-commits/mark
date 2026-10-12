"""
Детектор накрутки и ботового трафика (правила, без AI).

Для каждой кампании считаются признаки; score 0..100:
  • аномальный CTR при большом количестве показов
  • много кликов и ни одной конверсии
  • резкий всплеск кликов в один день относительно медианы
  • аномально дешёвые клики при большом объёме
"""
from statistics import median

MIN_IMPRESSIONS_FOR_CTR = 200
CTR_ANOMALY_PCT = 12.0
NO_CONV_MIN_CLICKS = 30
SPIKE_FACTOR = 4.0
SPIKE_MIN_MEDIAN = 5
CHEAP_CPC_KOP = 100  # 1 рубль
CHEAP_MIN_CLICKS = 50


def _verdict(score: int) -> str:
    if score >= 60:
        return "high"
    if score >= 30:
        return "medium"
    return "low"


def analyze_group(group: dict) -> dict:
    rows = group["rows"]
    s = group["summary"]
    flags: list[str] = []
    score = 0

    if s["impressions"] >= MIN_IMPRESSIONS_FOR_CTR and s["ctr"] > CTR_ANOMALY_PCT:
        flags.append(f"Аномальный CTR {s['ctr']}% при {s['impressions']} показах")
        score += 35

    if s["clicks"] >= NO_CONV_MIN_CLICKS and s["conversions"] == 0:
        flags.append(f"{s['clicks']} кликов без единой конверсии")
        score += 35

    daily_clicks = [r["clicks"] for r in rows if r["clicks"] > 0]
    if len(daily_clicks) >= 3:
        med = median(daily_clicks)
        if med >= SPIKE_MIN_MEDIAN and max(daily_clicks) > med * SPIKE_FACTOR:
            flags.append(f"Всплеск кликов: максимум {max(daily_clicks)} при медиане {int(med)} в день")
            score += 25

    if s["clicks"] >= CHEAP_MIN_CLICKS and 0 < s["cpc_kop"] < CHEAP_CPC_KOP:
        flags.append(f"Подозрительно низкая цена клика: {s['cpc_kop'] / 100:.2f} ₽")
        score += 15

    score = min(100, score)
    wasted = s["cost_kop"] if (flags and s["conversions"] == 0) else 0
    return {
        "campaign_id": group["campaign_id"],
        "name": group["name"],
        "score": score,
        "verdict": _verdict(score),
        "flags": flags,
        "wasted_kop": wasted,
        "cost_kop": s["cost_kop"],
    }


def analyze(groups: list[dict]) -> dict:
    items = [analyze_group(g) for g in groups]
    items.sort(key=lambda x: x["score"], reverse=True)
    return {
        "items": items,
        "risk_count": sum(1 for i in items if i["verdict"] != "low"),
        "wasted_kop": sum(i["wasted_kop"] for i in items),
    }
