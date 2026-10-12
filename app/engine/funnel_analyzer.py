"""Воронка: показы → клики → визиты → конверсии, с поиском самого большого провала."""


def build(impressions: int, clicks: int, visits: int, conversions: int) -> dict:
    raw = [
        ("impressions", "Показы", impressions),
        ("clicks", "Клики", clicks),
        ("visits", "Визиты на сайт", visits),
        ("conversions", "Конверсии", conversions),
    ]
    stages = []
    prev = None
    worst: tuple[float, str] | None = None
    for key, label, value in raw:
        rate = None
        if prev is not None:
            rate = round(value / prev * 100, 2) if prev else 0.0
            drop = 100 - rate
            if prev and (worst is None or drop > worst[0]):
                worst = (drop, label)
        stages.append({"key": key, "label": label, "value": value, "rate_from_prev": rate})
        prev = value

    if worst is None or all(s["value"] == 0 for s in stages):
        bottleneck = None
        advice = "Недостаточно данных для анализа воронки"
    else:
        bottleneck = worst[1]
        advice = f"Самый большой провал на этапе «{worst[1]}»: теряется {worst[0]:.0f}% пользователей"
    return {"stages": stages, "bottleneck": bottleneck, "advice": advice}
