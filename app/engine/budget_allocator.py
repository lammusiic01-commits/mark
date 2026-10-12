"""
Распределение дневного бюджета между кампаниями пропорционально эффективности
(конверсии на рубль). Гарантирует минимальную долю каждой активной кампании
и точную сумму (остаток отдаётся кампании с наибольшей долей).
"""


def allocate(total_kop: int, campaigns: list[dict], min_share: float = 0.05) -> list[dict]:
    if total_kop <= 0 or not campaigns:
        return []

    scores = []
    for c in campaigns:
        cost = c.get("cost_kop", 0)
        conv = c.get("conversions", 0)
        scores.append(conv / cost if cost > 0 else 0.0)

    total_score = sum(scores)
    n = len(campaigns)
    floor = min(max(min_share, 0.0), 1 / n)  # гарантированный минимум каждой кампании
    remaining = 1 - n * floor                # остальное делим пропорционально эффективности
    if total_score <= 0:
        shares = [1 / n] * n
    else:
        shares = [floor + remaining * (s / total_score) for s in scores]
    total_share = sum(shares)
    shares = [s / total_share for s in shares]

    amounts = [int(total_kop * s) for s in shares]
    remainder = total_kop - sum(amounts)
    order = sorted(range(n), key=lambda i: shares[i], reverse=True)
    for i in range(remainder):
        amounts[order[i % n]] += 1

    return [
        {"campaign_id": c["campaign_id"], "name": c["name"],
         "share_percent": round(shares[i] * 100, 1), "budget_kop": amounts[i]}
        for i, c in enumerate(campaigns)
    ]
