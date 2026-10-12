"""Оптимизатор ставок: считает, какую ставку поставить по каждой фразе.

Логика без магии и «на глаз»:
  • есть цель — цена конверсии (CPA) и её допустимые границы;
  • если фактическая CPA сильно выше цели — ставку снижаем;
  • если CPA ниже цели и показов не хватает — ставку поднимаем;
  • если кликов много, а конверсий ноль — ставку снижаем резко и
    предлагаем разобраться с фразой (это не «случайность», это слив);
  • шаг изменения ограничен, чтобы не «сломать» кампанию за один день.

Все деньги — в рублях, все изменения — с обоснованием и ожидаемым эффектом.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from engine import (
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

# Границы шага изменения ставки за один прогон
MAX_INCREASE_PCT = 30.0
MAX_DECREASE_PCT = 40.0

# Ниже этой доли показов считаем, что кампания «недополучает» трафик
LOW_IMPRESSION_SHARE = 0.55

# Сколько кликов нужно, чтобы уверенно судить об отсутствии конверсий
NO_CONVERSION_CLICKS = 30

# Ставка не может быть ниже и выше этих значений (₽)
MIN_BID_RUB = 0.30
MAX_BID_RUB = 3_000.0


@dataclass(frozen=True, slots=True)
class KeywordStat:
    """Статистика одной фразы (или кампании) за период."""

    keyword_id: str
    phrase: str
    campaign_id: str | None = None
    campaign_name: str | None = None
    clicks: int = 0
    impressions: int = 0
    cost_rub: float = 0.0
    conversions: float = 0.0
    current_bid_rub: float = 0.0
    impression_share: float | None = None  # 0..1, если Директ отдал
    ctr: float | None = None

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "KeywordStat":
        """Собирает статистику из строки отчёта (терпимо к формату)."""
        return cls(
            keyword_id=str(row.get("keyword_id") or row.get("id") or row.get("phrase") or ""),
            phrase=str(row.get("phrase") or row.get("keyword") or "без фразы"),
            campaign_id=str(row["campaign_id"]) if row.get("campaign_id") else None,
            campaign_name=row.get("campaign_name"),
            clicks=int(to_float(row.get("clicks"))),
            impressions=int(to_float(row.get("impressions"))),
            cost_rub=to_float(row.get("cost_rub") or row.get("cost")),
            conversions=to_float(row.get("conversions")),
            current_bid_rub=to_float(row.get("current_bid_rub") or row.get("bid")),
            impression_share=_optional_float(row.get("impression_share")),
            ctr=_optional_float(row.get("ctr")),
        )

    @property
    def cpc(self) -> float:
        """Цена клика. Ноль кликов — ноль данных, не «бесконечность»."""
        return round(safe_div(self.cost_rub, self.clicks), 2)

    @property
    def cpa(self) -> float | None:
        """Цена конверсии. None — если конверсий нет, считать CPA нельзя."""
        if self.conversions <= 0:
            return None
        return round(safe_div(self.cost_rub, self.conversions), 2)

    @property
    def effective_ctr(self) -> float:
        """CTR в процентах: из отчёта или посчитанный."""
        if self.ctr is not None:
            return round(self.ctr * 100 if self.ctr <= 1 else self.ctr, 2)
        return percent(self.clicks, self.impressions)


@dataclass(slots=True)
class BidChange:
    """Предложение по одной фразе: было, станет, почему, что это даст."""

    keyword_id: str
    phrase: str
    campaign_id: str | None
    campaign_name: str | None
    current_bid_rub: float
    recommended_bid_rub: float
    change_pct: float
    reason: str
    expected_cpa_rub: float | None
    expected_conversions: float
    confidence: str  # high | medium | low
    severity: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "keyword_id": self.keyword_id,
            "phrase": self.phrase,
            "campaign_id": self.campaign_id,
            "campaign_name": self.campaign_name,
            "current_bid_rub": money(self.current_bid_rub),
            "recommended_bid_rub": money(self.recommended_bid_rub),
            "change_pct": self.change_pct,
            "reason": self.reason,
            "expected_cpa_rub": money(self.expected_cpa_rub) if self.expected_cpa_rub is not None else None,
            "expected_conversions": round(self.expected_conversions, 2),
            "confidence": self.confidence,
            "severity": self.severity,
        }


@dataclass(slots=True)
class BidPlan:
    """Итоговый план: что менять, что оставить, насколько это выгодно."""

    changes: list[BidChange]
    threshold_rub: float
    target_cpa_rub: float
    summary: dict[str, Any]
    findings: list[Finding]
    skipped: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "changes": [change.to_dict() for change in self.changes],
            "skipped": self.skipped,
            "threshold_rub": money(self.threshold_rub),
            "target_cpa_rub": money(self.target_cpa_rub),
            "summary": self.summary,
            "findings": [finding.to_dict() for finding in self.findings],
        }


def optimize_bids(
    stats: Sequence[KeywordStat | dict[str, Any]],
    *,
    target_cpa_rub: float,
    monthly_budget_rub: float = 0.0,
    min_bid_rub: float = MIN_BID_RUB,
    max_bid_rub: float = MAX_BID_RUB,
    max_changes: int = 50,
) -> BidPlan:
    """Считает новые ставки по всем фразам.

    Целевая CPA — точка равновесия: к ней подтягиваем каждую фразу.
    Если конверсий нет вообще, правило «нет данных» отдельное: снижаем ставку
    и предлагаем проверить фразу, а не выключаем её молча.
    """
    if target_cpa_rub <= 0:
        raise ValueError("Нужна целевая цена конверсии: без неё оптимизация превращается в угадывание")

    normalized = [item if isinstance(item, KeywordStat) else KeywordStat.from_row(item) for item in stats]
    changes: list[BidChange] = []
    skipped: list[dict[str, Any]] = []

    # Порог «дорогой» CPA: выше цели на 30% — уже требует вмешательства
    threshold = round(target_cpa_rub * 1.3, 2)
    total_conversions_now = sum(item.conversions for item in normalized)
    total_cost = money(sum(item.cost_rub for item in normalized))

    for item in normalized:
        if item.clicks == 0 and item.impressions == 0:
            skipped.append({"phrase": item.phrase, "reason": "нет показов за период — нечего менять"})
            continue

        bid = item.current_bid_rub
        if bid <= 0:
            # Директ не отдал текущую ставку — считаем от фактического CPC
            bid = item.cpc or min_bid_rub
            if bid <= 0:
                skipped.append({"phrase": item.phrase, "reason": "неизвестна ставка и не было расхода"})
                continue

        decision = _decide(item, bid, target_cpa_rub, threshold)
        if decision is None:
            skipped.append({"phrase": item.phrase, "reason": "показатели в норме — ставка не меняется"})
            continue

        new_bid, reason, confidence, severity = decision
        new_bid = round(clamp(new_bid, min_bid_rub, max_bid_rub), 2)
        if abs(new_bid - bid) < 0.05:
            skipped.append({"phrase": item.phrase, "reason": "изменение меньше шага ставки"})
            continue

        expected_cpa = _expected_cpa(item, bid, new_bid, target_cpa_rub)
        expected_conversions = _expected_conversions(item, bid, new_bid)

        changes.append(
            BidChange(
                keyword_id=item.keyword_id,
                phrase=item.phrase,
                campaign_id=item.campaign_id,
                campaign_name=item.campaign_name,
                current_bid_rub=bid,
                recommended_bid_rub=new_bid,
                change_pct=change_pct(bid, new_bid),
                reason=reason,
                expected_cpa_rub=expected_cpa,
                expected_conversions=expected_conversions,
                confidence=confidence,
                severity=severity,
            ),
        )

    # Показываем самое важное: сначала снижение убыточных, потом рост потенциала
    changes.sort(key=lambda change: (change.severity != "critical", abs(change.change_pct) * -1))
    changed = changes[:max_changes]

    summary = _summary(normalized, changed, threshold, target_cpa_rub, monthly_budget_rub, total_cost, total_conversions_now)
    findings = _findings(changed, threshold, target_cpa_rub, summary)

    return BidPlan(
        changes=changed,
        threshold_rub=threshold,
        target_cpa_rub=target_cpa_rub,
        summary=summary,
        findings=findings,
        skipped=skipped[:20],
    )


def _decide(
    item: KeywordStat,
    bid: float,
    target_cpa: float,
    threshold: float,
) -> tuple[float, str, str, str] | None:
    """Решение по одной фразе: новая ставка, причина, уверенность, важность."""
    cpa = item.cpa

    # 1. Клики есть, конверсий нет — самый дорогой и самый частый случай
    if cpa is None and item.clicks >= NO_CONVERSION_CLICKS:
        cut = bid * (1 - MAX_DECREASE_PCT / 100)
        return (
            cut,
            f"{item.clicks} кликов и {money(item.cost_rub)} ₽ расходов без конверсий — "
            "снижаю ставку и рекомендую проверить релевантность фразы и посадочную страницу",
            "high",
            "critical",
        )

    # 2. CPA заметно выше цели — снижаем пропорционально перерасходу
    if cpa is not None and cpa > threshold:
        ratio = target_cpa / cpa
        reduction = clamp((1 - ratio) * 100, 5.0, MAX_DECREASE_PCT)
        return (
            bid * (1 - reduction / 100),
            f"Цена конверсии {money(cpa)} ₽ против цели {money(target_cpa)} ₽ — "
            f"снижаю ставку на {round(reduction)}%, чтобы вернуться в план",
            "high",
            "critical" if cpa > target_cpa * 2 else "warning",
        )

    # 3. CPA в норме, но показов мало — можно забрать больше трафика
    if (
        cpa is not None
        and cpa <= target_cpa * 0.9
        and (item.impression_share is None or item.impression_share < LOW_IMPRESSION_SHARE)
    ):
        increase = MAX_INCREASE_PCT if cpa <= target_cpa * 0.7 else MAX_INCREASE_PCT / 2
        share_text = (
            f"доля показов {round(item.impression_share * 100)}%"
            if item.impression_share is not None
            else "доля показов ограничена"
        )
        return (
            bid * (1 + increase / 100),
            f"Конверсии дешевле цели ({money(cpa)} ₽ против {money(target_cpa)} ₽), при этом {share_text} — "
            f"поднимаю ставку на {round(increase)}%, чтобы выкупить больше показов",
            "medium",
            "info",
        )

    # 4. CTR подозрительно низкий при большом расходе — проблема в объявлении
    if item.clicks >= 20 and item.effective_ctr < 0.8:
        return (
            bid * 0.9,
            f"CTR {item.effective_ctr}% — объявление не цепляет. Снижаю ставку на 10% "
            "и рекомендую переписать заголовок под фразу",
            "medium",
            "warning",
        )

    return None


def _expected_cpa(item: KeywordStat, old_bid: float, new_bid: float, target_cpa: float) -> float | None:
    """Ожидаемая CPA после изменения: ставка тянет цену клика за собой.

    Модель линейная и осторожная: цена клика меняется на 60% от изменения ставки
    (аукцион сглаживает резкие скачки), конверсии считаем от текущей конверсии.
    """
    if item.conversions <= 0 or item.clicks == 0:
        return None
    conversion_rate = safe_div(item.conversions, item.clicks)
    if conversion_rate <= 0:
        return None
    new_cpc = item.cpc * (1 + 0.6 * (new_bid / old_bid - 1))
    expected = safe_div(new_cpc, conversion_rate)
    return round(expected, 2) if expected else None


def _expected_conversions(item: KeywordStat, old_bid: float, new_bid: float) -> float:
    """Сколько конверсий ожидаем после изменения ставки (с учётом эластичности)."""
    if item.clicks == 0:
        return 0.0
    conversion_rate = safe_div(item.conversions, item.clicks)
    elasticity = 0.5  # половина прироста ставки превращается в прирост кликов
    new_clicks = item.clicks * (1 + elasticity * (new_bid / old_bid - 1))
    return max(0.0, round(new_clicks * conversion_rate, 2))


def _summary(
    stats: Sequence[KeywordStat],
    changes: Sequence[BidChange],
    threshold: float,
    target_cpa: float,
    monthly_budget: float,
    total_cost: float,
    total_conversions: float,
) -> dict[str, Any]:
    """Сводка по кампании: сколько фраз в норме, сколько переплачивают."""
    expensive = [item for item in stats if item.cpa is not None and item.cpa > threshold]
    no_conversion = [item for item in stats if item.cpa is None and item.clicks >= NO_CONVERSION_CLICKS]
    cheap = [item for item in stats if item.cpa is not None and item.cpa <= target_cpa * 0.9]

    # Экономия = переплата по фразам, где CPA выше цели (это видно в деньгах уже сейчас)
    savings = money(
        sum(
            (item.cpa - target_cpa) * item.conversions
            for item in expensive
            if item.cpa is not None and item.conversions > 0
        ),
    )
    potential_conversions = round(sum(change.expected_conversions for change in changes), 2)
    average_cpa = round(safe_div(total_cost, total_conversions), 2) if total_conversions else 0.0

    return {
        "keywords_total": len(stats),
        "keywords_changing": len(changes),
        "keywords_in_norm": len(stats) - len(changes),
        "overpriced": len(expensive),
        "no_conversions": len(no_conversion),
        "room_to_grow": len(cheap),
        "average_cpa_rub": average_cpa,
        "target_cpa_rub": money(target_cpa),
        "potential_savings_rub": savings,
        "potential_conversions": potential_conversions,
        "monthly_budget_rub": money(monthly_budget),
        "budget_utilization_pct": percent(total_cost, monthly_budget) if monthly_budget else 0.0,
    }


def _findings(
    changes: Sequence[BidChange],
    threshold: float,
    target_cpa: float,
    summary: dict[str, Any],
) -> list[Finding]:
    """Ключевые выводы для экрана кампаний."""
    findings: list[Finding] = []

    drop = [change for change in changes if change.change_pct < 0]
    grow = [change for change in changes if change.change_pct > 0]

    if drop:
        findings.append(
            Finding(
                code="bids:decrease",
                title=f"Снизить ставки у {len(drop)} фраз",
                description=(
                    f"Эти фразы дают конверсии дороже цели {money(target_cpa)} ₽ или не дают их вовсе. "
                    f"Снижение освободит около {money(sum(abs(c.change_pct) for c in drop) * 0)} ₽ — "
                    "точная экономия появится после недели наблюдений."
                ),
                severity="critical" if any(change.severity == "critical" for change in drop) else "warning",
                impact_rub=summary.get("potential_savings_rub", 0.0),
                action="Открыть кампании и применить новые ставки одной кнопкой",
                evidence={"phrases": [change.phrase for change in drop[:5]]},
            ),
        )

    if grow:
        findings.append(
            Finding(
                code="bids:increase",
                title=f"Поднять ставки у {len(grow)} фраз",
                description=(
                    f"Конверсии здесь дешевле цели, а показов не хватает. Ожидаемый прирост — "
                    f"{summary.get('potential_conversions', 0)} конверсий за период."
                ),
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Применить новые ставки — прирост показов придёт в течение 2–3 дней",
                evidence={"phrases": [change.phrase for change in grow[:5]]},
            ),
        )

    if summary.get("no_conversions"):
        findings.append(
            Finding(
                code="bids:no-conversions",
                title=f"{summary['no_conversions']} фраз сливают бюджет",
                description=(
                    f"У этих фраз минимум {NO_CONVERSION_CLICKS} кликов и ни одной конверсии. "
                    "Правило движка: снизить ставку сейчас, разобраться с фразой за неделю."
                ),
                severity=SEVERITY_WARNING,
                impact_rub=0.0,
                action="Проверить посадочные страницы и добавить минус-слова",
                evidence={"threshold_rub": money(threshold)},
            ),
        )

    if not changes:
        findings.append(
            Finding(
                code="bids:all-good",
                title="Ставки в порядке",
                description="Все фразы работают в пределах целевой цены конверсии — менять нечего.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Продолжаем наблюдение, проверка обновится автоматически",
            ),
        )

    return sort_by_impact(findings)


def _optional_float(value: Any) -> float | None:
    """None вместо «пусто» — чтобы отличать отсутствие данных от нуля."""
    if value is None or value == "":
        return None
    return to_float(value)


def build_demo_stats() -> list[KeywordStat]:
    """Тестовый набор фраз для демонстрации и автотестов."""
    return [
        KeywordStat("k1", "купить кондиционер москва", "c1", "Поиск — кондиционеры", clicks=62, impressions=4200, cost_rub=7440.0, conversions=6.0, current_bid_rub=140.0, impression_share=0.42, ctr=1.8),
        KeywordStat("k2", "кондиционер недорого", "c1", "Поиск — кондиционеры", clicks=48, impressions=3900, cost_rub=3360.0, conversions=0.0, current_bid_rub=75.0, impression_share=0.61, ctr=1.2),
        KeywordStat("k3", "установка кондиционера цена", "c1", "Поиск — кондиционеры", clicks=31, impressions=1500, cost_rub=4650.0, conversions=7.0, current_bid_rub=160.0, impression_share=0.38, ctr=2.1),
        KeywordStat("k4", "ремонт кондиционеров", "c2", "Поиск — ремонт", clicks=12, impressions=2100, cost_rub=1440.0, conversions=1.0, current_bid_rub=120.0, impression_share=0.72, ctr=0.6),
        KeywordStat("k5", "кондиционер в квартиру", "c1", "Поиск — кондиционеры", clicks=90, impressions=5200, cost_rub=6300.0, conversions=9.0, current_bid_rub=95.0, impression_share=0.30, ctr=1.7),
    ]


__all__ = [
    "MAX_DECREASE_PCT",
    "MAX_INCREASE_PCT",
    "NO_CONVERSION_CLICKS",
    "BidChange",
    "BidPlan",
    "KeywordStat",
    "build_demo_stats",
    "optimize_bids",
]
