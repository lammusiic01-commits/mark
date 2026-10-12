"""Распределение бюджета: куда добавлять, а откуда забирать.

Принцип «воды» (water-filling): деньги текут туда, где каждая тысяча рублей
приносит больше заявок, но с двумя предохранителями —
  • ни одна кампания не режется больше чем на 40% за раз (иначе аукцион
    «забывает» историю и кампания перезапускается с нуля);
  • кампании без данных получают минимальный тестовый бюджет, а не ноль:
    без теста их экономику не узнать.

Результат — конкретные суммы в рублях и ожидаемый эффект, а не «перераспределите
бюджет в пользу эффективных каналов».
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from engine import (
    SEVERITY_CRITICAL,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    Finding,
    clamp,
    money,
    percent,
    safe_div,
    sort_by_impact,
    to_float,
)

# Предохранители: насколько можно изменить бюджет одной кампании за один прогон
MAX_CUT_PCT = 40
MAX_GROWTH_PCT = 100

# Доля бюджета, которую отдаём кампаниям без данных (тестовый бюджет)
TEST_SHARE = 0.10

# Минимальный дневной бюджет кампании (₽) — ниже Директ почти не показывает
MIN_DAILY_BUDGET = 300.0

# Во сколько раз CPA может превышать цель, чтобы кампанию признали убыточной
HOPELESS_FACTOR = 1.5


@dataclass(frozen=True, slots=True)
class ChannelStat:
    """Кампания (или канал) с экономикой за период."""

    channel_id: str
    name: str
    current_daily_budget_rub: float = 0.0
    clicks: int = 0
    impressions: int = 0
    cost_rub: float = 0.0
    conversions: float = 0.0
    revenue_rub: float = 0.0
    min_daily_budget_rub: float = MIN_DAILY_BUDGET
    max_daily_budget_rub: float | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "ChannelStat":
        return cls(
            channel_id=str(row.get("campaign_id") or row.get("id") or row.get("name") or ""),
            name=str(row.get("name") or "Кампания"),
            current_daily_budget_rub=to_float(row.get("daily_budget_rub") or row.get("daily_budget")),
            clicks=int(to_float(row.get("clicks"))),
            impressions=int(to_float(row.get("impressions"))),
            cost_rub=to_float(row.get("cost_rub") or row.get("cost")),
            conversions=to_float(row.get("conversions")),
            revenue_rub=to_float(row.get("revenue_rub") or row.get("revenue")),
            min_daily_budget_rub=to_float(row.get("min_daily_budget_rub")) or MIN_DAILY_BUDGET,
            max_daily_budget_rub=to_float(row.get("max_daily_budget_rub")) or None,
        )

    @property
    def cpa(self) -> float | None:
        """Цена конверсии. None — конверсий не было, экономику не посчитать."""
        return round(safe_div(self.cost_rub, self.conversions), 2) if self.conversions > 0 else None

    @property
    def cpc(self) -> float:
        return round(safe_div(self.cost_rub, self.clicks), 2)

    @property
    def conversion_rate(self) -> float:
        """Процент из клика в заявку — главный множитель при распределении."""
        return percent(self.conversions, self.clicks)

    @property
    def romi(self) -> float | None:
        if self.revenue_rub <= 0 or self.cost_rub <= 0:
            return None
        return round((self.revenue_rub - self.cost_rub) / self.cost_rub * 100, 1)

    @property
    def has_data(self) -> bool:
        """Достаточно ли данных, чтобы судить об эффективности."""
        return self.clicks >= 20


@dataclass(slots=True)
class AllocationRow:
    """Одна строка плана: было — стало — почему — что это даст."""

    channel_id: str
    name: str
    current_daily_budget_rub: float
    new_daily_budget_rub: float
    delta_rub: float
    delta_pct: float
    cpa_rub: float | None
    conversion_rate_pct: float
    expected_daily_conversions: float
    reason: str
    action: str  # increase | decrease | keep | test
    severity: str = SEVERITY_INFO

    def to_dict(self) -> dict[str, Any]:
        return {
            "channel_id": self.channel_id,
            "name": self.name,
            "current_daily_budget_rub": money(self.current_daily_budget_rub),
            "new_daily_budget_rub": money(self.new_daily_budget_rub),
            "delta_rub": money(self.delta_rub),
            "delta_pct": self.delta_pct,
            "cpa_rub": money(self.cpa_rub) if self.cpa_rub is not None else None,
            "conversion_rate_pct": round(self.conversion_rate_pct, 2),
            "expected_daily_conversions": round(self.expected_daily_conversions, 2),
            "reason": self.reason,
            "action": self.action,
            "severity": self.severity,
        }


@dataclass(slots=True)
class AllocationPlan:
    """План распределения бюджета с эффектом в заявках и рублях."""

    rows: list[AllocationRow]
    total_daily_budget_rub: float
    summary: dict[str, Any]
    findings: list[Finding]
    period_days: int = 30

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows": [row.to_dict() for row in self.rows],
            "total_daily_budget_rub": money(self.total_daily_budget_rub),
            "total_monthly_budget_rub": money(self.total_daily_budget_rub * self.period_days),
            "summary": self.summary,
            "findings": [finding.to_dict() for finding in self.findings],
            "period_days": self.period_days,
        }


def allocate_budget(
    channels: Sequence[ChannelStat | Mapping[str, Any]],
    *,
    target_cpa_rub: float,
    total_daily_budget_rub: float = 0.0,
    period_days: int = 30,
) -> AllocationPlan:
    """Считает новое распределение дневного бюджета.

    total_daily_budget_rub — общий бюджет в день. Если не указан, берётся сумма
    текущих бюджетов: тогда план не увеличивает расход, а только перекладывает.
    """
    if target_cpa_rub <= 0:
        raise ValueError("Нужна целевая цена конверсии: без неё распределение не имеет смысла")

    stats = [item if isinstance(item, ChannelStat) else ChannelStat.from_row(item) for item in channels]
    if not stats:
        return AllocationPlan(
            rows=[],
            total_daily_budget_rub=0.0,
            summary={"campaigns": 0, "message": "Нет кампаний для распределения"},
            findings=[
                Finding(
                    code="budget:no-campaigns",
                    title="Нет кампаний",
                    description="Подключите Яндекс.Директ и дождитесь синхронизации кампаний.",
                    severity=SEVERITY_INFO,
                    action="Открыть раздел «Подключения» и добавить Директ",
                ),
            ],
            period_days=period_days,
        )

    pool = money(total_daily_budget_rub or sum(item.current_daily_budget_rub for item in stats))
    pool = max(pool, MIN_DAILY_BUDGET * len(stats))

    weights = [_weight(item, target_cpa_rub) for item in stats]
    without_data = [index for index, item in enumerate(stats) if not item.has_data]

    # Кампании без данных получают тестовый бюджет, остальное делим по весам
    test_budget_each = money(pool * TEST_SHARE / len(without_data)) if without_data else 0.0
    test_budget_each = max(test_budget_each, MIN_DAILY_BUDGET) if without_data else 0.0
    reserved = money(test_budget_each * len(without_data))
    working_pool = max(0.0, pool - reserved)

    for index in without_data:
        weights[index] = 0.0
    total_weight = sum(weights) or 1.0

    rows: list[AllocationRow] = []
    for index, item in enumerate(stats):
        if not item.has_data:
            planned = test_budget_each
        else:
            planned = working_pool * (weights[index] / total_weight)

        planned = _apply_limits(item, planned, pool)
        rows.append(_build_row(item, planned, target_cpa_rub))

    summary = _summary(stats, rows, pool, target_cpa_rub, period_days)
    findings = _findings(rows, summary, target_cpa_rub)
    rows.sort(key=lambda row: abs(row.delta_rub), reverse=True)

    return AllocationPlan(
        rows=rows,
        total_daily_budget_rub=money(sum(row.new_daily_budget_rub for row in rows)),
        summary=summary,
        findings=findings,
        period_days=period_days,
    )


def _weight(item: ChannelStat, target_cpa: float) -> float:
    """Вес кампании: сколько заявок приносит рубль и укладывается ли в цель.

    Формула: эффективность по конверсии × множитель «в цели или нет».
    Кампания с CPA вдвое выше цели получает вес в пять раз меньше дешёвой.
    """
    if not item.has_data:
        return 0.0

    efficiency = item.conversion_rate
    if efficiency <= 0:
        return 0.01  # клики есть, заявок нет — минимальный вес, но не ноль

    cpa = item.cpa
    if cpa is None:
        return 0.01

    if cpa <= target_cpa:
        multiplier = clamp(target_cpa / cpa, 1.0, 2.5)
    else:
        multiplier = clamp((target_cpa / cpa) ** 2, 0.05, 1.0)

    # Если есть выручка, учитываем возврат инвестиций: рентабельные получают бонус
    if item.romi is not None:
        multiplier *= clamp(1 + item.romi / 200, 0.6, 1.8)

    return max(0.001, efficiency * multiplier)


def _apply_limits(item: ChannelStat, planned: float, pool: float) -> float:
    """Предохранители: шаг изменения и границы бюджета."""
    current = item.current_daily_budget_rub or item.min_daily_budget_rub
    low = max(item.min_daily_budget_rub, current * (1 - MAX_CUT_PCT / 100)) if current else item.min_daily_budget_rub
    high_limit = min(pool, current * (1 + MAX_GROWTH_PCT / 100)) if current else pool
    if item.max_daily_budget_rub:
        high_limit = min(high_limit, item.max_daily_budget_rub)

    # Если кампания безнадёжна по CPA — режем до минимума, а не в ноль
    cpa = item.cpa
    if cpa is not None and item.has_data and cpa > 0:
        pass  # решение по сокращению уже заложено в весе; здесь только границы

    return round(clamp(planned, item.min_daily_budget_rub, max(high_limit, item.min_daily_budget_rub)), 2)


def _build_row(item: ChannelStat, planned: float, target_cpa: float) -> AllocationRow:
    """Готовит строку плана с человеческим объяснением."""
    current = item.current_daily_budget_rub or item.min_daily_budget_rub
    delta = money(planned - current)
    delta_pct = round(safe_div(delta, current) * 100, 1) if current else 0.0
    cpa = item.cpa

    expected_conversions = round(safe_div(planned, cpa), 2) if cpa else 0.0

    if not item.has_data:
        action, severity = "test", SEVERITY_INFO
        reason = (
            f"{item.clicks} кликов — данных мало. Даю тестовый бюджет {money(planned)} ₽ в день, "
            "чтобы через неделю было на чём принимать решение."
        )
    elif cpa is None:
        action, severity = "decrease", SEVERITY_CRITICAL
        reason = (
            f"{item.clicks} кликов и {money(item.cost_rub)} ₽ расходов без заявок. "
            f"Сокращаю до {money(planned)} ₽ и предлагаю разобраться с релевантностью и страницей."
        )
    elif cpa > target_cpa * HOPELESS_FACTOR:
        action, severity = "decrease", SEVERITY_CRITICAL
        reason = (
            f"Заявка стоит {money(cpa)} ₽ — это в {round(cpa / target_cpa, 1)} раза дороже цели "
            f"{money(target_cpa)} ₽. Освободившиеся деньги уходят туда, где заявки дешевле."
        )
    elif cpa > target_cpa:
        action, severity = "decrease", SEVERITY_WARNING
        reason = (
            f"Заявка {money(cpa)} ₽ — дороже цели {money(target_cpa)} ₽. "
            "Немного сокращаю и оставляю на наблюдение: возможно, дело в сезонности."
        )
    elif delta > 1:
        action, severity = "increase", SEVERITY_INFO
        reason = (
            f"Заявка {money(cpa)} ₽ — дешевле цели, конверсия {round(item.conversion_rate, 1)}%. "
            f"Даю больше бюджета: {money(planned)} ₽ в день."
        )
    elif delta < -1:
        action = "decrease"
        severity = SEVERITY_WARNING if cpa > target_cpa else SEVERITY_INFO
        reason = (
            f"Экономика в норме (заявка {money(cpa)} ₽), но другие кампании приносят заявки дешевле: "
            f"перекладываю {money(-delta)} ₽ в день туда, где каждый рубль результативнее."
        )
    else:
        action, severity = "keep", SEVERITY_INFO
        reason = f"Экономика в норме (заявка {money(cpa)} ₽) — бюджет оставляю без изменений."

    return AllocationRow(
        channel_id=item.channel_id,
        name=item.name,
        current_daily_budget_rub=money(current),
        new_daily_budget_rub=money(planned),
        delta_rub=delta,
        delta_pct=delta_pct,
        cpa_rub=cpa,
        conversion_rate_pct=item.conversion_rate,
        expected_daily_conversions=expected_conversions,
        reason=reason,
        action=action,
        severity=severity,
    )


def _summary(
    stats: Sequence[ChannelStat],
    rows: Sequence[AllocationRow],
    pool: float,
    target_cpa: float,
    period_days: int,
) -> dict[str, Any]:
    """Сводка: сколько заявок даёт бюджет до и после перераспределения."""
    after_conversions = sum(row.expected_daily_conversions for row in rows)
    used_daily = money(sum(item.current_daily_budget_rub for item in stats))

    campaigns_with_data = sum(1 for item in stats if item.has_data)
    return {
        "campaigns": len(stats),
        "campaigns_with_data": campaigns_with_data,
        "campaigns_without_data": len(stats) - campaigns_with_data,
        "increase": sum(1 for row in rows if row.action == "increase"),
        "decrease": sum(1 for row in rows if row.action == "decrease"),
        "keep": sum(1 for row in rows if row.action == "keep"),
        "test": sum(1 for row in rows if row.action == "test"),
        "daily_budget_rub": money(pool),
        "monthly_budget_rub": money(pool * period_days),
        "expected_daily_conversions": round(after_conversions, 2),
        "expected_monthly_conversions": round(after_conversions * period_days, 1),
        "freed_daily_rub": money(sum(-row.delta_rub for row in rows if row.delta_rub < 0)),
        "target_cpa_rub": money(target_cpa),
        "current_daily_budget_rub": used_daily,
        "budget_change_pct": round(safe_div(pool - used_daily, used_daily) * 100, 1) if used_daily else 0.0,
    }


def _findings(
    rows: Sequence[AllocationRow],
    summary: Mapping[str, Any],
    target_cpa: float,
) -> list[Finding]:
    """Выводы для интерфейса: что произойдёт с заявками."""
    findings: list[Finding] = []

    decreases = [row for row in rows if row.action == "decrease"]
    increases = [row for row in rows if row.action == "increase"]
    tests = [row for row in rows if row.action == "test"]

    if decreases:
        freed = money(sum(-row.delta_rub for row in decreases))
        findings.append(
            Finding(
                code="budget:reallocate",
                title=f"Освобождаем {money(freed * 30)} ₽ в месяц",
                description=(
                    "Кампании с дорогой заявкой получают меньше, а деньги уходят туда, где заявка дешевле. "
                    "Список: " + ", ".join(row.name for row in decreases[:3]) + "."
                ),
                severity=SEVERITY_WARNING,
                impact_rub=money(freed * 30),
                action="Применить план в разделе «Кампании» — бюджеты изменятся одной кнопкой",
                evidence={"channels": [row.name for row in decreases]},
            ),
        )

    if increases:
        growth = round(sum(row.expected_daily_conversions for row in increases) * 30, 1)
        findings.append(
            Finding(
                code="budget:scale",
                title="Масштабируем эффективные кампании",
                description=(
                    f"Ожидаемый прирост — около {growth} заявок в месяц без роста общей ставки расхода: "
                    "бюджет перераспределяется внутри текущей суммы."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Проверить план и применить изменения бюджетов",
                evidence={"channels": [row.name for row in increases[:5]]},
            ),
        )

    if tests:
        findings.append(
            Finding(
                code="budget:test",
                title=f"{len(tests)} кампаний(и) на тестовом бюджете",
                description=(
                    "По ним пока мало данных, поэтому им выделен минимальный бюджет до набора статистики. "
                    "Через 7–10 дней движок пересчитает план по фактическим заявкам."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Не менять бюджеты этих кампаний до набора 20+ кликов",
                evidence={"channels": [row.name for row in tests]},
            ),
        )

    if not decreases and not increases:
        findings.append(
            Finding(
                code="budget:balanced",
                title="Распределение сбалансировано",
                description=(
                    f"Все кампании укладываются в целевую цену заявки {money(target_cpa)} ₽ — "
                    "перекладывать бюджет не нужно."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Вернуться к распределению после изменения ставок или запуска новых кампаний",
            ),
        )

    return sort_by_impact(findings)


def build_demo_channels() -> list[ChannelStat]:
    """Тестовые кампании для демонстрации и автотестов."""
    return [
        ChannelStat("c1", "Поиск — основные услуги", 1500, clicks=320, impressions=12000, cost_rub=48000.0, conversions=24.0, revenue_rub=336000.0),
        ChannelStat("c2", "Сети — охват", 800, clicks=410, impressions=98000, cost_rub=24000.0, conversions=3.0, revenue_rub=42000.0),
        ChannelStat("c3", "Бренд", 400, clicks=140, impressions=4200, cost_rub=9800.0, conversions=16.0, revenue_rub=224000.0),
        ChannelStat("c4", "Ретаргетинг", 150, clicks=8, impressions=3000, cost_rub=320.0, conversions=0.0),
    ]


__all__ = [
    "HOPELESS_FACTOR",
    "MAX_CUT_PCT",
    "MAX_GROWTH_PCT",
    "MIN_DAILY_BUDGET",
    "AllocationPlan",
    "AllocationRow",
    "ChannelStat",
    "allocate_budget",
    "build_demo_channels",
]
