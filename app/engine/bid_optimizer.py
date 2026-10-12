"""
Рекомендации по ставкам и паузам на основе целевого CPA (правила, без AI).
"""

MIN_CLICKS = 30
PAUSE_MULTIPLIER = 2.0      # расход без конверсий > 2 × целевого CPA → пауза
DECREASE_MULTIPLIER = 1.25  # CPA выше цели на 25% → снизить ставку
INCREASE_MULTIPLIER = 0.75  # CPA ниже цели на 25% → можно поднять ставку


def recommend_group(group: dict, target_cpa_kop: int) -> dict:
    s = group["summary"]
    base = {"campaign_id": group["campaign_id"], "name": group["name"], "status": group["status"]}

    if target_cpa_kop <= 0:
        return {**base, "action": "keep", "bid_change_pct": 0,
                "reason": "Укажи целевой CPA в настройках, чтобы получать рекомендации"}
    if s["clicks"] < MIN_CLICKS:
        return {**base, "action": "keep", "bid_change_pct": 0,
                "reason": f"Мало данных: {s['clicks']} кликов из {MIN_CLICKS} нужных"}

    if s["conversions"] == 0:
        if s["cost_kop"] > target_cpa_kop * PAUSE_MULTIPLIER:
            return {**base, "action": "pause", "bid_change_pct": 0,
                    "reason": "Расход больше удвоенного целевого CPA и нет конверсий"}
        return {**base, "action": "keep", "bid_change_pct": 0,
                "reason": "Конверсий пока нет, расход в допустимых пределах"}

    cpa = s["cost_kop"] / s["conversions"]
    if cpa > target_cpa_kop * DECREASE_MULTIPLIER:
        pct = -15 if cpa > target_cpa_kop * 1.5 else -10
        return {**base, "action": "decrease_bid", "bid_change_pct": pct,
                "reason": f"CPA {cpa / 100:.0f} ₽ выше цели {target_cpa_kop / 100:.0f} ₽"}
    if cpa < target_cpa_kop * INCREASE_MULTIPLIER:
        return {**base, "action": "increase_bid", "bid_change_pct": 10,
                "reason": f"CPA {cpa / 100:.0f} ₽ ниже цели {target_cpa_kop / 100:.0f} ₽, можно масштабировать"}
    return {**base, "action": "keep", "bid_change_pct": 0,
            "reason": f"CPA {cpa / 100:.0f} ₽ близок к цели"}


def recommend(groups: list[dict], target_cpa_kop: int) -> list[dict]:
    return [recommend_group(g, target_cpa_kop) for g in groups]
