"""
A/B-тесты: двухвыборочный z-тест долей (конверсий) — чистая статистика, без AI.
"""
import math

MIN_N_PER_ARM = 100
ALPHA = 0.05


def two_proportion_ztest(conv_a: int, n_a: int, conv_b: int, n_b: int) -> dict:
    if n_a <= 0 or n_b <= 0:
        raise ValueError("В каждой группе должен быть хотя бы один посетитель")
    if conv_a < 0 or conv_b < 0 or conv_a > n_a or conv_b > n_b:
        raise ValueError("Конверсии не могут быть больше посетителей или отрицательными")

    pa = conv_a / n_a
    pb = conv_b / n_b
    pooled = (conv_a + conv_b) / (n_a + n_b)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    if se == 0:
        z, p_value = 0.0, 1.0
    else:
        z = (pb - pa) / se
        p_value = math.erfc(abs(z) / math.sqrt(2))
    lift = round((pb - pa) / pa * 100, 2) if pa > 0 else None
    return {
        "cr_a": round(pa * 100, 2),
        "cr_b": round(pb * 100, 2),
        "z": round(z, 3),
        "p_value": round(p_value, 4),
        "lift_pct": lift,
    }


def needed_per_arm(baseline_cr: float, mde_relative: float = 0.2) -> int | None:
    """Оценка размера выборки на группу для обнаружения относительного эффекта mde (80% мощности, α=0.05)."""
    if baseline_cr <= 0:
        return None
    p1 = baseline_cr
    p2 = baseline_cr * (1 + mde_relative)
    z_alpha, z_beta = 1.959964, 0.841621
    delta = p2 - p1
    n = (z_alpha + z_beta) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2)) / delta ** 2
    return math.ceil(n)


def evaluate(a_visitors: int, a_conversions: int, b_visitors: int, b_conversions: int) -> dict:
    sample_ok = min(a_visitors, b_visitors) >= MIN_N_PER_ARM
    if a_visitors == 0 or b_visitors == 0:
        return {"status": "collecting", "winner": None, "sample_ok": False,
                "verdict": "Добавь данные по обеим группам", "needed_per_arm": None,
                "cr_a": 0.0, "cr_b": 0.0, "p_value": None, "lift_pct": None, "z": None}

    stats = two_proportion_ztest(a_conversions, a_visitors, b_conversions, b_visitors)
    needed = needed_per_arm(stats["cr_a"] / 100)
    significant = stats["p_value"] < ALPHA

    if not sample_ok:
        status, winner = "collecting", None
        verdict = f"Недостаточно данных: нужно минимум {MIN_N_PER_ARM} посетителей в каждой группе"
    elif significant:
        winner = "B" if stats["cr_b"] > stats["cr_a"] else "A"
        status = "significant"
        verdict = f"Вариант {winner} статистически лучше (p = {stats['p_value']})"
    else:
        status, winner = "no_difference", None
        verdict = f"Значимой разницы нет (p = {stats['p_value']}), продолжай тест или сохрани текущий вариант"

    return {**stats, "status": status, "winner": winner, "sample_ok": sample_ok,
            "verdict": verdict, "needed_per_arm": needed}
