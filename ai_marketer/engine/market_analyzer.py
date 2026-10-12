"""Анализ рынка: сколько стоит клик в нише, сколько заявок реально получить.

Данные для сравнения — ориентиры по нишам (средние цены клика и конверсии
по опыту ведения кампаний в России). Это не «гадание»: цифры используются
как точка отсчёта, а решения принимаются по данным самого клиента —
если у него клик дешевле ориентира, движок говорит об этом прямо.

Модуль отвечает на три вопроса:
  1. Переплачиваю ли я за клик относительно рынка?
  2. Сколько заявок даст мой бюджет на этом рынке?
  3. Что делать в первую очередь, чтобы улучшить экономику?
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from engine import (
    SEVERITY_CRITICAL,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    Finding,
    money,
    percent,
    safe_div,
    sort_by_impact,
    to_float,
)

# Ориентиры по нишам: (мин. CPC, типичный CPC, макс. CPC, типичная конверсия %)
# Значения — ориентир для планирования, а не гарантия: рынок меняется по сезонам.
NICHE_BENCHMARKS: dict[str, dict[str, Any]] = {
    "стройка-ремонт": {"cpc": (25, 55, 120), "conversion": 4.5, "name": "Стройка и ремонт", "competition": "высокая"},
    "климат-техника": {"cpc": (30, 62, 140), "conversion": 4.0, "name": "Климатическая техника", "competition": "высокая"},
    "медицина-клиники": {"cpc": (45, 95, 220), "conversion": 6.5, "name": "Медицина и клиники", "competition": "очень высокая"},
    "стоматология": {"cpc": (50, 110, 260), "conversion": 7.0, "name": "Стоматология", "competition": "очень высокая"},
    "юристы-бухгалтеры": {"cpc": (40, 90, 210), "conversion": 5.0, "name": "Юристы и бухгалтеры", "competition": "высокая"},
    "авто-сервис": {"cpc": (20, 48, 110), "conversion": 5.5, "name": "Автосервис", "competition": "средняя"},
    "недвижимость": {"cpc": (35, 85, 240), "conversion": 3.0, "name": "Недвижимость", "competition": "очень высокая"},
    "образование-курсы": {"cpc": (22, 52, 130), "conversion": 4.0, "name": "Образование и курсы", "competition": "высокая"},
    "красота-салоны": {"cpc": (18, 42, 95), "conversion": 6.0, "name": "Красота и салоны", "competition": "средняя"},
    "b2b-услуги": {"cpc": (40, 88, 200), "conversion": 3.5, "name": "B2B-услуги", "competition": "высокая"},
    "доставка-логистика": {"cpc": (24, 56, 130), "conversion": 4.5, "name": "Доставка и логистика", "competition": "средняя"},
    "интернет-магазин": {"cpc": (15, 38, 90), "conversion": 2.5, "name": "Интернет-магазин", "competition": "высокая"},
    "другое": {"cpc": (20, 50, 120), "conversion": 4.0, "name": "Другие услуги", "competition": "средняя"},
}

# Во сколько раз Москва/СПб дороже среднего региона
CAPITAL_MULTIPLIER = 1.65
CAPITAL_REGIONS = (213, 1, 2, 3)

# Сколько фраз обычно в кампании и сколько конкурентов в аукционе по нишам
COMPETITORS_BY_COMPETITION = {
    "средняя": (3, 6),
    "высокая": (6, 12),
    "очень высокая": (10, 20),
}


@dataclass(slots=True)
class MarketAnalysis:
    """Оценка рынка и план бюджета под цели клиента."""

    niche: str
    niche_name: str
    competition: str
    region_code: int
    region_name: str
    market_cpc_rub: float
    your_cpc_rub: float
    gap_pct: float
    competitors: dict[str, int]
    budget_plan: list[dict[str, Any]]
    best_scenario: dict[str, Any]
    conservative_scenario: dict[str, Any]
    advice: list[str]
    findings: list[Finding]
    benchmarks: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "niche": self.niche,
            "niche_name": self.niche_name,
            "competition": self.competition,
            "region_code": self.region_code,
            "region_name": self.region_name,
            "market_cpc_rub": money(self.market_cpc_rub),
            "your_cpc_rub": money(self.your_cpc_rub),
            "gap_pct": self.gap_pct,
            "competitors": self.competitors,
            "budget_plan": self.budget_plan,
            "best_scenario": self.best_scenario,
            "conservative_scenario": self.conservative_scenario,
            "advice": self.advice,
            "findings": [finding.to_dict() for finding in self.findings],
            "benchmarks": self.benchmarks,
        }


def analyze_market(
    *,
    niche: str = "другое",
    region_code: int = 213,
    region_name: str | None = None,
    monthly_budget_rub: float = 0.0,
    daily_budget_rub: float = 0.0,
    your_clicks: int = 0,
    your_cost_rub: float = 0.0,
    your_conversions: float = 0.0,
    target_cpa_rub: float = 0.0,
    average_order_rub: float = 0.0,
) -> MarketAnalysis:
    """Собирает картину рынка и план действий.

    Важно: цена клика и конверсия берутся из ориентиров ниши, а затем
    корректируются на регион. Ваши фактические цифры перекрывают ориентир,
    когда данные есть — сравнение получается честным.
    """
    key = niche if niche in NICHE_BENCHMARKS else _guess_niche(niche)
    bench = NICHE_BENCHMARKS[key]
    cpc_low, cpc_typical, cpc_high = bench["cpc"]

    # Региональная поправка: в столицах клик дороже
    multiplier = CAPITAL_MULTIPLIER if region_code in CAPITAL_REGIONS else 1.0
    market_cpc = round((cpc_low + cpc_typical * 2 + cpc_high) / 4 * multiplier, 2)
    market_conversion = float(bench["conversion"])

    your_cpc = round(safe_div(your_cost_rub, your_clicks), 2) if your_clicks else 0.0
    gap_pct = round((your_cpc / market_cpc - 1) * 100, 1) if your_cpc and market_cpc else 0.0

    monthly_budget = money(monthly_budget_rub or daily_budget_rub * 30)
    if monthly_budget <= 0 and your_cost_rub > 0:
        monthly_budget = money(your_cost_rub * 30 / 14)

    conversions = your_conversions
    if conversions <= 0 and your_clicks:
        # Конверсий нет — считаем по ориентиру ниши, чтобы всё равно дать план
        conversions = round(your_clicks * market_conversion / 100, 2)

    effective_cpa = (
        round(safe_div(your_cost_rub, your_conversions), 2)
        if your_conversions > 0
        else round(safe_div(your_cost_rub, conversions), 2) if conversions else 0.0
    )

    competitors = _competitors(bench["competition"])
    budget_plan = _budget_plan(monthly_budget, market_cpc, market_conversion, your_cpc or market_cpc, target_cpa_rub)
    best, conservative = _scenarios(monthly_budget, your_cpc or market_cpc, market_conversion, average_order_rub, target_cpa_rub)
    advice = _advice(
        gap_pct=gap_pct,
        your_cpc=your_cpc,
        market_cpc=market_cpc,
        effective_cpa=effective_cpa,
        target_cpa=target_cpa_rub,
        monthly_budget=monthly_budget,
        competitors=competitors,
        best=best,
        niche_name=bench["name"],
    )

    findings = _findings(
        gap_pct=gap_pct,
        your_cpc=your_cpc,
        market_cpc=market_cpc,
        effective_cpa=effective_cpa,
        target_cpa=target_cpa_rub,
        best=best,
        monthly_budget=monthly_budget,
    )

    return MarketAnalysis(
        niche=key,
        niche_name=bench["name"],
        competition=bench["competition"],
        region_code=region_code,
        region_name=region_name or "Москва",
        market_cpc_rub=market_cpc,
        your_cpc_rub=your_cpc,
        gap_pct=gap_pct,
        competitors=competitors,
        budget_plan=budget_plan,
        best_scenario=best,
        conservative_scenario=conservative,
        advice=advice,
        findings=findings,
        benchmarks={
            "cpc_range_rub": [cpc_low, cpc_high],
            "typical_conversion_pct": market_conversion,
            "capital_multiplier": multiplier,
            "niches_available": sorted(NICHE_BENCHMARKS),
        },
    )


def _guess_niche(text: str) -> str:
    """Определяет нишу по словам из описания клиента."""
    lowered = (text or "").lower()
    keywords = {
        "стройка-ремонт": ("ремонт", "строй", "отделк", "окна", "мебел"),
        "климат-техника": ("кондиционер", "климат", "вентил", "котл", "отоплен"),
        "медицина-клиники": ("клиник", "медицин", "анализ", "врач", "лечен"),
        "стоматология": ("стомат", "зуб", "имплант", "брекет"),
        "юристы-бухгалтеры": ("юрист", "адвокат", "бухгалт", "налог", "суд"),
        "авто-сервис": ("авто", "автомобил", "шиномонтаж", "сто", "кузов"),
        "недвижимость": ("недвижим", "квартир", "аренд", "агентств", "новострой"),
        "образование-курсы": ("курс", "обучен", "школ", "репетит", "образован"),
        "красота-салоны": ("салон", "красот", "маникюр", "стрижк", "космет"),
        "b2b-услуги": ("b2b", "оптом", "производств", "оборудован", "логист"),
        "доставка-логистика": ("доставк", "груз", "перевозк", "логист"),
        "интернет-магазин": ("магазин", "товар", "shop", "маркетплейс"),
    }
    for niche, words in keywords.items():
        if any(word in lowered for word in words):
            return niche
    return "другое"


def _competitors(competition: str) -> dict[str, int]:
    """Сколько конкурентов в аукционе: диапазон и оценка."""
    low, high = COMPETITORS_BY_COMPETITION.get(competition, (3, 8))
    return {
        "min": low,
        "max": high,
        "estimate": (low + high) // 2,
    }


def _budget_plan(
    monthly_budget: float,
    market_cpc: float,
    market_conversion: float,
    your_cpc: float,
    target_cpa: float,
) -> list[dict[str, Any]]:
    """Как распределить бюджет: поиск, сети, ретаргетинг, тесты.

    Пропорции стандартные для услуг в России: ядро — поиск, остальное —
    расширение и возврат аудитории.
    """
    if monthly_budget <= 0:
        return []

    cpc = your_cpc or market_cpc
    plan = [
        ("Поиск — основные запросы", 0.55, "Ядро спроса: сюда идёт основная часть бюджета"),
        ("Ретаргетинг и возврат", 0.15, "Тёплая аудитория дешевле нового клика в 2–3 раза"),
        ("Тесты новых фраз и гео", 0.15, "Новые направления проверяем отдельным бюджетом"),
        ("Сети и медийный охват", 0.15, "Дешёвый охват для узнаваемости и догоняющей рекламы"),
    ]

    rows: list[dict[str, Any]] = []
    for name, share, why in plan:
        budget = money(monthly_budget * share)
        clicks = int(safe_div(budget, max(cpc, 1)))
        conversions = round(clicks * (market_conversion / 100), 1)
        cpa = round(safe_div(budget, conversions), 2) if conversions else 0.0
        rows.append(
            {
                "channel": name,
                "share_pct": round(share * 100),
                "budget_rub": budget,
                "expected_clicks": clicks,
                "expected_conversions": conversions,
                "expected_cpa_rub": cpa,
                "fits_target": bool(target_cpa and cpa and cpa <= target_cpa * 1.2),
                "why": why,
            },
        )
    return rows


def _scenarios(
    monthly_budget: float,
    cpc: float,
    market_conversion: float,
    average_order: float,
    target_cpa: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Два сценария: оптимистичный (после настройки) и осторожный (как сейчас)."""
    if monthly_budget <= 0:
        return {}, {}

    base_clicks = int(safe_div(monthly_budget, max(cpc, 1)))

    # Оптимистичный: минус мусорный трафик, плюс работа над конверсией
    best_conversion = market_conversion * 1.25
    best_clicks = int(base_clicks * 1.1)
    best_conversions = round(best_clicks * best_conversion / 100, 1)
    best_cpa = round(safe_div(monthly_budget, best_conversions), 2)

    # Осторожный: без изменений
    safe_conversions = round(base_clicks * market_conversion * 0.8 / 100, 1)
    safe_cpa = round(safe_div(monthly_budget, safe_conversions), 2)

    def scenario(clicks: int, conversions: float, cpa: float, label: str) -> dict[str, Any]:
        return {
            "label": label,
            "clicks": clicks,
            "conversions": conversions,
            "cpa_rub": cpa,
            "revenue_rub": money(conversions * average_order) if average_order else 0.0,
            "profit_rub": money(conversions * average_order - monthly_budget) if average_order else 0.0,
            "fits_target": bool(target_cpa and cpa <= target_cpa),
        }

    return (
        scenario(best_clicks, best_conversions, best_cpa, "После настройки и чистки трафика"),
        scenario(base_clicks, safe_conversions, safe_cpa, "Если ничего не менять"),
    )


def _advice(
    *,
    gap_pct: float,
    your_cpc: float,
    market_cpc: float,
    effective_cpa: float,
    target_cpa: float,
    monthly_budget: float,
    competitors: Mapping[str, int],
    best: Mapping[str, Any],
    niche_name: str,
) -> list[str]:
    """Список советов в порядке «сначала самое важное»."""
    advice: list[str] = []

    if monthly_budget <= 0:
        advice.append("Задайте дневной бюджет в кампании — без него план распределения построить нельзя.")
        return advice

    if your_cpc and gap_pct >= 25:
        advice.append(
            f"Клик у вас {money(your_cpc)} ₽ — на {round(gap_pct)}% дороже рынка ({money(market_cpc)} ₽). "
            "Проверьте: не забираете ли вы верхние позиции там, где достаточно середины, и нет ли мусорных площадок.",
        )
    elif your_cpc and gap_pct <= -15:
        advice.append(
            f"Клик дешевле рынка на {abs(round(gap_pct))}% ({money(your_cpc)} ₽ против {money(market_cpc)} ₽). "
            "Это хороший момент для роста бюджета — вы покупаете трафик выгоднее конкурентов.",
        )
    elif your_cpc:
        advice.append(f"Цена клика в норме: {money(your_cpc)} ₽ против рыночных {money(market_cpc)} ₽ в нише «{niche_name}».")

    if target_cpa and effective_cpa:
        if effective_cpa > target_cpa * 1.25:
            advice.append(
                f"Цена заявки {money(effective_cpa)} ₽ выше цели {money(target_cpa)} ₽. "
                "Первый шаг — чистка мусорного трафика и ставок, он даёт эффект за неделю.",
            )
        else:
            advice.append(
                f"Экономика в цели: заявка {money(effective_cpa)} ₽ при плане {money(target_cpa)} ₽. "
                "Можно масштабировать бюджет на 20–30%.",
            )

    advice.append(
        f"В аукционе ориентировочно {competitors.get('estimate', 6)} конкурирующих объявлений — "
        "разница в тексте объявления и посадочной странице влияет на позицию сильнее, чем лишние 10% ставки.",
    )
    if best:
        advice.append(
            f"Ориентир по бюджету: {money(monthly_budget)} ₽ в месяц → около {best.get('conversions', 0)} заявок "
            f"при цене {money(best.get('cpa_rub', 0))} ₽ за заявку."
        )
    return advice[:5]


def _findings(
    *,
    gap_pct: float,
    your_cpc: float,
    market_cpc: float,
    effective_cpa: float,
    target_cpa: float,
    best: Mapping[str, Any],
    monthly_budget: float,
) -> list[Finding]:
    """Находки для интерфейса: где мы относительно рынка."""
    findings: list[Finding] = []

    if your_cpc and gap_pct >= 25:
        findings.append(
            Finding(
                code="market:cpc-high",
                title=f"Клик дороже рынка на {round(gap_pct)}%",
                description=(
                    f"Ваша цена клика {money(your_cpc)} ₽ против рыночных {money(market_cpc)} ₽. "
                    "Причины обычно: высокая конкуренция по фразе, низкий CTR, ставка «на максимум»."
                ),
                severity=SEVERITY_WARNING,
                impact_rub=money((your_cpc - market_cpc) * 100),
                action="Снизить ставки по дорогим фразам и переписать объявления с низким CTR",
            ),
        )
    if target_cpa and effective_cpa and effective_cpa > target_cpa * 1.25:
        findings.append(
            Finding(
                code="market:cpa-high",
                title="Заявка дороже цели",
                description=(
                    f"Фактическая цена заявки {money(effective_cpa)} ₽ против цели {money(target_cpa)} ₽. "
                    "В этой нише разрыв обычно закрывается чисткой трафика и работой с конверсией страницы."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=money(max(0.0, effective_cpa - target_cpa)),
                action="Применить план ставок и проверить посадочную страницу",
            ),
        )
    if best:
        findings.append(
            Finding(
                code="market:scenario",
                title=f"Реалистичный сценарий: {best.get('conversions', 0)} заявок",
                description=(
                    f"При бюджете {money(monthly_budget)} ₽ в месяц вы можете выйти на "
                    f"{best.get('conversions', 0)} заявок по цене {money(best.get('cpa_rub', 0))} ₽."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Сверить план с гипотезами роста и запустить первые два шага",
            ),
        )

    if not findings:
        findings.append(
            Finding(
                code="market:ok",
                title="Показатели соответствуют рынку",
                description="Цена клика и цена заявки укладываются в ориентиры ниши.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Держать текущую настройку и проверять экономику раз в две недели",
            ),
        )

    return sort_by_impact(findings)


def niches_catalog() -> list[dict[str, Any]]:
    """Справочник ниш — для выпадающего списка в приложении."""
    return [
        {
            "code": code,
            "name": data["name"],
            "competition": data["competition"],
            "cpc_range_rub": list(data["cpc"][:2]),
            "typical_conversion_pct": data["conversion"],
        }
        for code, data in sorted(NICHE_BENCHMARKS.items(), key=lambda item: item[1]["name"])
    ]


def compare_with_market(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Сравнение фактических цен клика по кампаниям с ориентиром ниши."""
    result: list[dict[str, Any]] = []
    for row in rows:
        niche = str(row.get("niche", "другое"))
        bench = NICHE_BENCHMARKS.get(niche, NICHE_BENCHMARKS["другое"])
        market_cpc = round(sum(bench["cpc"]) / 3, 2)
        clicks = int(to_float(row.get("clicks")))
        cost = to_float(row.get("cost_rub"))
        your_cpc = round(safe_div(cost, clicks), 2) if clicks else 0.0
        result.append(
            {
                "name": row.get("name") or "Кампания",
                "niche": bench["name"],
                "your_cpc_rub": your_cpc,
                "market_cpc_rub": market_cpc,
                "gap_pct": round((your_cpc / market_cpc - 1) * 100, 1) if your_cpc else 0.0,
                "your_conversion_pct": round(safe_div(to_float(row.get("conversions")), clicks) * 100, 2) if clicks else 0.0,
                "market_conversion_pct": bench["conversion"],
            },
        )
    return result


__all__ = [
    "CAPITAL_MULTIPLIER",
    "NICHE_BENCHMARKS",
    "MarketAnalysis",
    "analyze_market",
    "compare_with_market",
    "niches_catalog",
]
