"""Движок расчётов: решения принимает только он, без участия ИИ.

Правило проекта: искусственный интеллект никогда не решает, «что делать» —
он лишь пересказывает человеку выводы движка. Поэтому все цифры, пороги и
деньги считаются здесь, в чистых функциях:

    bot_detector      — находит ботовый трафик и считает утечку бюджета
    bid_optimizer     — пересчитывает ставки под целевую цену конверсии
    hypothesis_engine — собирает гипотезы роста с расчётом в рублях
    seo_analyzer      — проверяет сайт: мета-теги, скорость, мобильность
    geo_analyzer      — сравнивает регионы и предлагает гео-корректировки
    market_analyzer   — оценивает рынок: CPC, конкуренцию, бюджетный план
    budget_allocator  — распределяет бюджет между кампаниями
    campaign_manager  — готовит изменения кампаний и применяет их в Директе

В этом файле живут общие типы и формулы, чтобы модули не дублировали код.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Mapping, Sequence

# Уровни важности находок — используются и в интерфейсе, и в отчётах
SEVERITY_CRITICAL = "critical"
SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"
SEVERITIES = (SEVERITY_CRITICAL, SEVERITY_WARNING, SEVERITY_INFO)

# Микрорубли: Директ отдаёт деньги в микроединицах (1 ₽ = 1 000 000)
MICRO = 1_000_000

# Дни месяца для пересчёта «за период» → «за месяц»
DAYS_IN_MONTH = 30


def from_micro(value: float | int | str | None) -> float:
    """Микрорубли → рубли. Всё, что приходит из Директа, проходит через это."""
    return round(to_float(value) / MICRO, 2)


def to_micro(value: float | int | str | None) -> int:
    """Рубли → микрорубли (для запросов в Директ)."""
    return int(round(to_float(value) * MICRO))


def to_float(value: Any, default: float = 0.0) -> float:
    """Безопасное приведение к числу: None, «—», «1 234,5 ₽» → число."""
    if value is None:
        return default
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value) if not math.isnan(float(value)) else default

    text = str(value).strip().replace("\u00a0", "").replace(" ", "").replace("₽", "").replace(",", ".")
    if not text or text in {"-", "—", "N/A", "null"}:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Деление без падения: при нулевом знаменателе — понятное значение.

    Отдельно важный случай из ТЗ: CPA при нуле конверсий не «бесконечность»,
    а отсутствие данных — такие ставки считаются отдельным правилом.
    """
    if not denominator:
        return default
    result = numerator / denominator
    if math.isinf(result) or math.isnan(result):
        return default
    return result


def percent(part: float, total: float) -> float:
    """Доля в процентах с одним знаком: 12.3."""
    return round(safe_div(part, total) * 100, 1)


def change_pct(before: float, after: float) -> float:
    """Изменение в процентах: (после − до) / до × 100."""
    return round(safe_div(after - before, before) * 100, 1)


def clamp(value: float, low: float, high: float) -> float:
    """Ограничение значения диапазоном."""
    return max(low, min(high, value))


def money(value: float) -> float:
    """Округление денег до копеек."""
    return round(to_float(value), 2)


def monthly(value: float, days: int) -> float:
    """Пересчёт суммы за период в сумму за месяц."""
    if days <= 0:
        return money(value)
    return money(value * DAYS_IN_MONTH / days)


@dataclass(frozen=True, slots=True)
class Finding:
    """Одна находка движка: что случилось, почему это важно и что делать.

    Один и тот же тип используется детектором ботов, SEO-анализом и
    оптимизатором ставок — интерфейс и отчёты умеют показывать любой набор.
    """

    code: str
    title: str
    description: str
    severity: str = SEVERITY_INFO
    impact_rub: float = 0.0
    action: str = ""
    evidence: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["impact_rub"] = money(self.impact_rub)
        data["evidence"] = dict(self.evidence)
        return data

    @property
    def is_critical(self) -> bool:
        return self.severity == SEVERITY_CRITICAL


@dataclass(frozen=True, slots=True)
class ActionItem:
    """Конкретное действие для пользователя: кнопка «Применить» в приложении."""

    code: str
    title: str
    description: str
    impact_rub: float = 0.0
    effort: str = "easy"  # easy | medium | hard — влияет на приоритет
    payload: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["impact_rub"] = money(self.impact_rub)
        data["payload"] = dict(self.payload)
        return data


def total_impact(findings: Iterable[Finding | ActionItem]) -> float:
    """Суммарный эффект набора находок в рублях в месяц."""
    return money(sum(item.impact_rub for item in findings))


def sort_by_impact(findings: Sequence[Finding], reverse: bool = True) -> list[Finding]:
    """Сортировка находок: сначала самые дорогие для бизнеса."""
    severity_weight = {SEVERITY_CRITICAL: 2, SEVERITY_WARNING: 1, SEVERITY_INFO: 0}
    return sorted(
        findings,
        key=lambda item: (item.impact_rub, severity_weight.get(item.severity, 0)),
        reverse=reverse,
    )


def summarize(findings: Sequence[Finding]) -> dict[str, Any]:
    """Сводка для карточки в интерфейсе: сколько проблем и сколько денег."""
    return {
        "total": len(findings),
        "critical": sum(1 for item in findings if item.severity == SEVERITY_CRITICAL),
        "warning": sum(1 for item in findings if item.severity == SEVERITY_WARNING),
        "info": sum(1 for item in findings if item.severity == SEVERITY_INFO),
        "impact_rub": total_impact(findings),
        "impact_text": f"{total_impact(findings):,.0f}".replace(",", " ") + " ₽",
    }


__all__ = [
    "ActionItem",
    "DAYS_IN_MONTH",
    "Finding",
    "MICRO",
    "SEVERITIES",
    "SEVERITY_CRITICAL",
    "SEVERITY_INFO",
    "SEVERITY_WARNING",
    "change_pct",
    "clamp",
    "from_micro",
    "money",
    "monthly",
    "percent",
    "safe_div",
    "sort_by_impact",
    "summarize",
    "to_float",
    "to_micro",
    "total_impact",
]
