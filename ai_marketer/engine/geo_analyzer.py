"""Гео-анализ: где реклама зарабатывает, а где тратит лишнее.

Идея: цена клика и конверсия сильно зависят от города. Москва и Питер дороже,
регионы дешевле, но и спрос там другой. Модуль сравнивает фактические данные
по регионам и говорит, что сделать: где поднять ставку, где снизить, где
отключить показы и какой город стоит попробовать следующим.

Коды регионов — официальные идентификаторы Яндекса (lr), те же, что в Директе.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from engine import (
    SEVERITY_CRITICAL,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    Finding,
    change_pct,
    clamp,
    money,
    percent,
    safe_div,
    sort_by_impact,
    to_float,
)

# Коды регионов Яндекса (используются в Директе и Метрике)
REGION_NAMES: dict[int, str] = {
    213: "Москва",
    1: "Москва и область",
    2: "Санкт-Петербург",
    3: "Санкт-Петербург и область",
    43: "Казань",
    54: "Екатеринбург",
    65: "Новосибирск",
    172: "Уфа",
    35: "Краснодар",
    39: "Ростов-на-Дону",
    47: "Нижний Новгород",
    51: "Самара",
    56: "Челябинск",
    62: "Красноярск",
    66: "Омск",
    75: "Владивосток",
    76: "Хабаровск",
    239: "Сочи",
    973: "Сургут",
    225: "Россия",
    149: "Беларусь",
    159: "Казахстан",
}

# Города с высокой конкуренцией: там клики дороже в среднем в 1.5–2 раза
EXPENSIVE_REGIONS: tuple[int, ...] = (213, 1, 2, 3)

# Минимум кликов, чтобы делать вывод по региону
MIN_CLICKS_FOR_DECISION = 15

# Границы корректировки ставки для региона (%)
MAX_REGION_ADJUST_PCT = 40


def region_name(code: int) -> str:
    """Название региона по коду: 213 → Москва, неизвестный — «Регион 213»."""
    return REGION_NAMES.get(int(code), f"Регион {int(code)}")


@dataclass(frozen=True, slots=True)
class RegionStat:
    """Данные по одному региону за период."""

    region_code: int
    impressions: int = 0
    clicks: int = 0
    cost_rub: float = 0.0
    conversions: float = 0.0
    revenue_rub: float = 0.0

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "RegionStat":
        return cls(
            region_code=int(to_float(row.get("region_code") or row.get("lr") or 0)),
            impressions=int(to_float(row.get("impressions"))),
            clicks=int(to_float(row.get("clicks"))),
            cost_rub=to_float(row.get("cost_rub") or row.get("cost")),
            conversions=to_float(row.get("conversions")),
            revenue_rub=to_float(row.get("revenue_rub") or row.get("revenue")),
        )

    @property
    def name(self) -> str:
        return region_name(self.region_code)

    @property
    def cpc(self) -> float:
        return round(safe_div(self.cost_rub, self.clicks), 2)

    @property
    def cpa(self) -> float | None:
        """Цена конверсии. None — конверсий нет, вывод делать нельзя."""
        return round(safe_div(self.cost_rub, self.conversions), 2) if self.conversions > 0 else None

    @property
    def conversion_rate(self) -> float:
        return percent(self.conversions, self.clicks)

    @property
    def ctr(self) -> float:
        return percent(self.clicks, self.impressions)

    @property
    def romi(self) -> float | None:
        """Возврат на маркетинг в процентах. None — если выручку не передали."""
        if self.revenue_rub <= 0 or self.cost_rub <= 0:
            return None
        return round((self.revenue_rub - self.cost_rub) / self.cost_rub * 100, 1)


@dataclass(slots=True)
class RegionAdvice:
    """Что делать с регионом: корректировка ставки, отключение или тест."""

    region_code: int
    region_name: str
    action: str  # increase | decrease | pause | keep | expand
    adjust_pct: float
    reason: str
    cost_rub: float
    cpa_rub: float | None
    conversions: float
    savings_rub: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "region_code": self.region_code,
            "region_name": self.region_name,
            "action": self.action,
            "adjust_pct": round(self.adjust_pct, 1),
            "reason": self.reason,
            "cost_rub": money(self.cost_rub),
            "cpa_rub": money(self.cpa_rub) if self.cpa_rub is not None else None,
            "conversions": round(self.conversions, 2),
            "savings_rub": money(self.savings_rub),
        }


@dataclass(slots=True)
class GeoPlan:
    """Итог гео-анализа: советы по регионам и план тестирования новых."""

    advices: list[RegionAdvice]
    expansion: list[dict[str, Any]]
    summary: dict[str, Any]
    findings: list[Finding]
    target_regions: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "advices": [advice.to_dict() for advice in self.advices],
            "expansion": self.expansion,
            "summary": self.summary,
            "findings": [finding.to_dict() for finding in self.findings],
            "target_regions": self.target_regions,
        }

    @property
    def recommendations(self) -> list[str]:
        """Короткие формулировки для интерфейса."""
        return [advice.reason for advice in self.advices[:6]]


def analyze_geo(
    stats: Sequence[RegionStat | Mapping[str, Any]],
    *,
    target_cpa_rub: float,
    target_regions: Sequence[int] | None = None,
    active_regions: Sequence[int] | None = None,
    total_budget_rub: float = 0.0,
) -> GeoPlan:
    """Разбирает регионы и предлагает конкретные корректировки ставок.

    target_cpa_rub — целевая цена конверсии: главный ориентир для решений.
    active_regions — где сейчас показываемся (нужно, чтобы советовать новые).
    """
    if target_cpa_rub <= 0:
        raise ValueError("Нужна целевая цена конверсии — без неё гео-анализ невозможен")

    regions = [item if isinstance(item, RegionStat) else RegionStat.from_row(item) for item in stats]
    regions = [item for item in regions if item.region_code]
    active = list(active_regions or [item.region_code for item in regions])
    targets = list(target_regions or [])

    advices: list[RegionAdvice] = []
    for item in regions:
        advices.append(_advice_for_region(item, target_cpa_rub, in_targets=item.region_code in targets))

    # Новые регионы: где ещё не показываемся и где клик дешевле
    expansion = _expansion_plan(regions, active, target_cpa_rub, total_budget_rub)

    total_cost = money(sum(item.cost_rub for item in regions))
    total_conversions = round(sum(item.conversions for item in regions), 2)
    savings = money(sum(advice.savings_rub for advice in advices))
    best = max(
        (item for item in regions if item.cpa is not None and item.clicks >= MIN_CLICKS_FOR_DECISION),
        key=lambda item: item.conversions,
        default=None,
    )
    worst = max(
        (item for item in regions if item.cpa is not None and item.cpa > target_cpa_rub),
        key=lambda item: item.cost_rub,
        default=None,
    )

    summary = {
        "regions_total": len(regions),
        "regions_worked": sum(1 for item in regions if item.clicks > 0),
        "regions_cleaned": sum(1 for item in advices if item.action == "pause"),
        "regions_to_increase": sum(1 for advice in advices if advice.action == "increase"),
        "regions_to_decrease": sum(1 for advice in advices if advice.action == "decrease"),
        "total_cost_rub": total_cost,
        "total_conversions": total_conversions,
        "average_cpa_rub": round(safe_div(total_cost, total_conversions), 2) if total_conversions else 0.0,
        "potential_savings_rub": savings,
        "best_region": best.name if best else None,
        "problem_region": worst.name if worst else None,
        "expansion_candidates": len(expansion),
    }

    findings = _findings(advices, summary, target_cpa_rub, expansion)
    advices.sort(key=lambda advice: (advice.action != "pause", -advice.cost_rub))

    return GeoPlan(
        advices=advices,
        expansion=expansion,
        summary=summary,
        findings=findings,
        target_regions=targets,
    )


def _advice_for_region(item: RegionStat, target_cpa: float, *, in_targets: bool) -> RegionAdvice:
    """Решение по одному региону."""
    acceptable = target_cpa * 1.25  # допускаем перерасход до 25%

    if item.clicks < MIN_CLICKS_FOR_DECISION:
        return RegionAdvice(
            region_code=item.region_code,
            region_name=item.name,
            action="keep",
            adjust_pct=0.0,
            reason=(
                f"{item.name}: пока {item.clicks} кликов — данных мало. Ставку не трогаем, "
                f"наблюдаем ещё неделю (расход {money(item.cost_rub)} ₽)."
            ),
            cost_rub=item.cost_rub,
            cpa_rub=item.cpa,
            conversions=item.conversions,
        )

    cpa = item.cpa

    # Регион тратит деньги и не даёт конверсий
    if cpa is None:
        reduction = 50.0
        return RegionAdvice(
            region_code=item.region_code,
            region_name=item.name,
            action="decrease" if item.cost_rub < 5000 else "pause",
            adjust_pct=-reduction if item.cost_rub < 5000 else -100.0,
            reason=(
                f"{item.name}: {item.clicks} кликов и {money(item.cost_rub)} ₽ без конверсий. "
                + (
                    "Снижаем ставку на 50% и следим неделю."
                    if item.cost_rub < 5000
                    else "Расход уже существенный — отключаем показы и разбираемся с релевантностью."
                )
            ),
            cost_rub=item.cost_rub,
            cpa_rub=None,
            conversions=0.0,
            savings_rub=money(item.cost_rub * (0.5 if item.cost_rub < 5000 else 0.9)),
        )

    # Слишком дорогие конверсии
    if cpa > acceptable:
        excess = cpa / target_cpa
        reduction = clamp((1 - 1 / excess) * 100 + 10, 10.0, MAX_REGION_ADJUST_PCT)
        return RegionAdvice(
            region_code=item.region_code,
            region_name=item.name,
            action="decrease",
            adjust_pct=-reduction,
            reason=(
                f"{item.name}: конверсия стоит {money(cpa)} ₽ против цели {money(target_cpa)} ₽ — "
                f"снижаем корректировку ставки на {round(reduction)}%."
            ),
            cost_rub=item.cost_rub,
            cpa_rub=cpa,
            conversions=item.conversions,
            savings_rub=money(max(0.0, (cpa - target_cpa) * item.conversions)),
        )

    # Дешёвая конверсия — забираем больше трафика
    if cpa <= target_cpa * 0.8:
        growth = clamp((target_cpa / cpa - 1) * 60, 10.0, MAX_REGION_ADJUST_PCT)
        return RegionAdvice(
            region_code=item.region_code,
            region_name=item.name,
            action="increase",
            adjust_pct=growth,
            reason=(
                f"{item.name}: конверсия {money(cpa)} ₽ — дешевле цели на "
                f"{round((1 - cpa / target_cpa) * 100)}%. Поднимаем корректировку на {round(growth)}%, "
                "чтобы забрать больше показов."
            ),
            cost_rub=item.cost_rub,
            cpa_rub=cpa,
            conversions=item.conversions,
        )

    # Норма
    hint = "" if in_targets else " Регион не в списке целевых — проверьте, нужен ли он."
    return RegionAdvice(
        region_code=item.region_code,
        region_name=item.name,
        action="keep",
        adjust_pct=0.0,
        reason=(
            f"{item.name}: конверсия {money(cpa)} ₽ — в пределах цели, {round(item.conversion_rate, 1)}% из клика в заявку. "
            f"Оставляем как есть.{hint}"
        ),
        cost_rub=item.cost_rub,
        cpa_rub=cpa,
        conversions=item.conversions,
    )


def _expansion_plan(
    stats: Sequence[RegionStat],
    active_regions: Sequence[int],
    target_cpa: float,
    total_budget: float,
) -> list[dict[str, Any]]:
    """Куда расширяться: города, похожие по цене на уже работающие."""
    if not stats:
        return []

    cheap_working = [
        item for item in stats
        if item.cpa is not None and item.cpa <= target_cpa and item.clicks >= MIN_CLICKS_FOR_DECISION
    ]
    budget_per_region = money(max(3000.0, (total_budget or 30000) * 0.08))
    average_cpc = round(safe_div(sum(item.cost_rub for item in stats), sum(item.clicks for item in stats)), 2) or 30.0

    candidates = [
        code for code in REGION_NAMES
        if code not in active_regions and code not in {225, 149, 159} and code not in EXPENSIVE_REGIONS
    ]
    if cheap_working:
        # Работающие дешёвые регионы — ориентир: ищем похожие по порядку величины
        cheap_codes = {item.region_code for item in cheap_working}
        candidates = [code for code in candidates if code not in cheap_codes]

    plan: list[dict[str, Any]] = []
    for code in candidates[:3]:
        plan.append(
            {
                "region_code": code,
                "region_name": region_name(code),
                "why": (
                    f"Клик здесь ожидается около {money(average_cpc)} ₽. "
                    "Отдельная кампания даёт чистый замер: видно спрос и цену заявки до масштабирования."
                ),
                "test_budget_rub": budget_per_region,
                "duration_days": 14,
                "expected_clicks": int(safe_div(budget_per_region, max(average_cpc, 1))),
                "success_criteria": f"цена конверсии не выше {money(target_cpa)} ₽ к 14-му дню",
            },
        )
    return plan


def _findings(
    advices: Sequence[RegionAdvice],
    summary: Mapping[str, Any],
    target_cpa: float,
    expansion: Sequence[Mapping[str, Any]],
) -> list[Finding]:
    """Ключевые выводы гео-анализа для интерфейса."""
    findings: list[Finding] = []

    pauses = [advice for advice in advices if advice.action == "pause"]
    if pauses:
        findings.append(
            Finding(
                code="geo:pause",
                title=f"Отключить показы в {len(pauses)} регионе(ах)",
                description=(
                    "Там накопился расход без конверсий: "
                    + ", ".join(f"{item.region_name} — {money(item.cost_rub)} ₽" for item in pauses[:3])
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=money(sum(item.savings_rub for item in pauses)),
                action="Отключить регионы в настройках кампании и перераспределить бюджет на работающие города",
                evidence={"regions": [item.region_name for item in pauses]},
            ),
        )

    decreases = [advice for advice in advices if advice.action == "decrease"]
    if decreases:
        findings.append(
            Finding(
                code="geo:decrease",
                title=f"Снизить ставки в {len(decreases)} регионе(ах)",
                description="Цена заявки там выше цели — корректировка вернёт экономику в норму без потери объёма.",
                severity=SEVERITY_WARNING,
                impact_rub=money(sum(item.savings_rub for item in decreases)),
                action="Применить гео-корректировки в разделе «Кампании»",
                evidence={
                    "regions": [
                        {"region": item.region_name, "adjust_pct": round(item.adjust_pct, 1), "cpa_rub": item.cpa_rub}
                        for item in decreases[:5]
                    ],
                },
            ),
        )

    increases = [advice for advice in advices if advice.action == "increase"]
    if increases:
        findings.append(
            Finding(
                code="geo:increase",
                title=f"Забрать больше трафика в {len(increases)} регионе(ах)",
                description=(
                    "Здесь заявки дешевле цели — это самый выгодный рост при том же бюджете. "
                    "Точки роста: " + ", ".join(item.region_name for item in increases[:3])
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Поднять гео-корректировки на рекомендованные проценты",
                evidence={"regions": [item.region_name for item in increases]},
            ),
        )

    if expansion:
        findings.append(
            Finding(
                code="geo:expand",
                title=f"Протестировать {len(expansion)} новых региона",
                description=(
                    "Спрос есть в городах, где мы пока не показываемся. Тест отдельной кампанией даёт "
                    "понятный замер цены заявки за две недели."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Запустить тестовую кампанию на 2 недели с бюджетом из плана",
                evidence={
                    "regions": [item["region_name"] for item in expansion],
                    "budget_rub": money(sum(to_float(item["test_budget_rub"]) for item in expansion)),
                },
            ),
        )

    if not findings:
        findings.append(
            Finding(
                code="geo:ok",
                title="География работает ровно",
                description=(
                    f"Средняя цена заявки {money(summary.get('average_cpa_rub', 0))} ₽ — все регионы "
                    f"укладываются в цель {money(target_cpa)} ₽."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Проверить гео снова через две недели или после изменения ставок",
            ),
        )

    return sort_by_impact(findings)


def compare_regions(stats: Sequence[RegionStat | Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Таблица для интерфейса: регионы и их показатели."""
    regions = [item if isinstance(item, RegionStat) else RegionStat.from_row(item) for item in stats]
    regions = [item for item in regions if item.region_code]
    rows = [
        {
            "region_code": item.region_code,
            "region_name": item.name,
            "impressions": item.impressions,
            "clicks": item.clicks,
            "cost_rub": money(item.cost_rub),
            "conversions": round(item.conversions, 2),
            "cpc_rub": item.cpc,
            "cpa_rub": item.cpa,
            "conversion_rate_pct": round(item.conversion_rate, 2),
            "ctr_pct": round(item.ctr, 2),
            "romi_pct": item.romi,
        }
        for item in regions
    ]
    rows.sort(key=lambda row: to_float(row["cost_rub"]), reverse=True)
    return rows


def demo_stats() -> list[RegionStat]:
    """Тестовые регионы для демонстрации и автотестов."""
    return [
        RegionStat(213, impressions=18_500, clicks=420, cost_rub=52_500.0, conversions=18.0, revenue_rub=210_000.0),
        RegionStat(2, impressions=9_200, clicks=210, cost_rub=21_000.0, conversions=14.0, revenue_rub=168_000.0),
        RegionStat(54, impressions=6_400, clicks=180, cost_rub=9_900.0, conversions=13.0, revenue_rub=140_000.0),
        RegionStat(43, impressions=4_100, clicks=120, cost_rub=6_000.0, conversions=9.0, revenue_rub=98_000.0),
        RegionStat(76, impressions=2_800, clicks=64, cost_rub=5_760.0, conversions=0.0),
    ]


__all__ = [
    "EXPENSIVE_REGIONS",
    "MIN_CLICKS_FOR_DECISION",
    "REGION_NAMES",
    "GeoPlan",
    "RegionAdvice",
    "RegionStat",
    "analyze_geo",
    "compare_regions",
    "demo_stats",
    "region_name",
]
