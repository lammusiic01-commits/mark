"""
Калькулятор ROI контекстной рекламы: прогноз по бюджету, цене клика и конверсии.
Чистая арифметика, без AI.
"""


def calculate(budget_rub: float, cpc_rub: float, cr_percent: float,
              avg_check_rub: float, margin_percent: float) -> dict:
    for name, value in (("бюджет", budget_rub), ("цена клика", cpc_rub),
                        ("avg_check", avg_check_rub)):
        if value < 0:
            raise ValueError(f"Значение «{name}» не может быть отрицательным")
    if cpc_rub <= 0:
        raise ValueError("Цена клика должна быть больше нуля")
    if not 0 <= cr_percent <= 100 or not 0 <= margin_percent <= 100:
        raise ValueError("Конверсия и маржа — проценты от 0 до 100")

    clicks = budget_rub / cpc_rub
    conversions = clicks * cr_percent / 100
    revenue = conversions * avg_check_rub
    gross_profit = revenue * margin_percent / 100
    profit = gross_profit - budget_rub
    roi = profit / budget_rub * 100 if budget_rub else 0.0
    cpa = budget_rub / conversions if conversions else None
    breakeven_cpa = avg_check_rub * margin_percent / 100
    breakeven_cpc = breakeven_cpa * cr_percent / 100

    if breakeven_cpa <= 0:
        verdict = "Маржа равна нулю: реклама не окупается"
    elif cpa is not None and cpa <= breakeven_cpa:
        verdict = "Кампания окупается при заданных параметрах"
    else:
        verdict = "Кампания не окупается: снизь цену клика или подними конверсию"

    return {
        "clicks": round(clicks),
        "conversions": round(conversions, 2),
        "revenue_rub": round(revenue, 2),
        "gross_profit_rub": round(gross_profit, 2),
        "profit_rub": round(profit, 2),
        "roi_percent": round(roi, 1),
        "cpa_rub": round(cpa, 2) if cpa is not None else None,
        "breakeven_cpa_rub": round(breakeven_cpa, 2),
        "breakeven_cpc_rub": round(breakeven_cpc, 2),
        "verdict": verdict,
    }
