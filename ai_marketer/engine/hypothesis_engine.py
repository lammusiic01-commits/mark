"""Генератор гипотез роста: превращает цифры в проверяемые шаги.

Гипотеза в этом продукте — не лозунг, а карточка с пятью полями:
что делаем, сколько это стоит, сколько займёт, какой эффект ждём (в %) и
насколько уверены. Эффект всегда считается от данных клиента, а не «из головы»:
если расходов нет — получится гипотеза «сначала соберите статистику».

Правила собраны по опыту ведения Директа и сгруппированы по типам:
трафик, конверсия, деньги, сайт, аудитория.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from engine import (
    SEVERITY_INFO,
    money,
    percent,
    safe_div,
    to_float,
)

# Типы гипотез (используются и как тег, и как фильтр в интерфейсе)
TYPE_TRAFFIC = "traffic"
TYPE_CONVERSION = "conversion"
TYPE_BUDGET = "budget"
TYPE_SITE = "site"
TYPE_AUDIENCE = "audience"
TYPE_TECH = "tech"

# Длительность проверки по умолчанию, дней
DEFAULT_DURATION_DAYS = 14


@dataclass(frozen=True, slots=True)
class HypothesisCard:
    """Готовая гипотеза: код, описание, эффект, бюджет, приоритет."""

    code: str
    type: str
    title: str
    description: str
    expected_impact_pct: float
    required_budget: float
    duration_days: int
    priority: int
    confidence: str  # high | medium | low
    action: str
    metrics: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "type": self.type,
            "title": self.title,
            "description": self.description,
            "expected_impact_pct": round(self.expected_impact_pct, 1),
            "required_budget": money(self.required_budget),
            "duration_days": self.duration_days,
            "priority": self.priority,
            "confidence": self.confidence,
            "action": self.action,
            "metrics": dict(self.metrics),
        }

    @property
    def priority_label(self) -> str:
        """Текстовая метка приоритета для интерфейса."""
        if self.priority >= 80:
            return "высокий"
        if self.priority >= 50:
            return "средний"
        return "низкий"


@dataclass(slots=True)
class HypothesisSet:
    """Набор гипотез с обоснованием — то, что видит пользователь в приложении."""

    cards: list[HypothesisCard]
    inputs: dict[str, Any]
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "hypotheses": [card.to_dict() for card in self.cards],
            "inputs": self.inputs,
            "notes": self.notes,
            "total_impact_pct": round(sum(card.expected_impact_pct for card in self.cards[:5]), 1),
            "total_budget_rub": money(sum(card.required_budget for card in self.cards[:5])),
        }

    @property
    def top(self) -> HypothesisCard | None:
        """Самая приоритетная гипотеза — попадает на дашборд."""
        return self.cards[0] if self.cards else None


# ─── Входные данные ────────────────────────────────────────────

DEFAULT_INPUTS: dict[str, Any] = {
    "clicks": 0,
    "impressions": 0,
    "cost_rub": 0.0,
    "conversions": 0.0,
    "revenue_rub": 0.0,
    "target_cpa_rub": 0.0,
    "daily_budget_rub": 0.0,
    "bot_share_pct": 0.0,
    "bot_wasted_rub": 0.0,
    "site_score": 100,
    "site_issues": 0,
    "lost_impression_share": 0.0,
    "active_campaigns": 1,
    "regions_used": 1,
    "has_retargeting": False,
    "has_metrika": True,
    "has_goals": True,
    "no_conversion_keywords": 0,
    "expensive_keywords": 0,
    "avg_position": 0.0,
    "mobile_share_pct": 0.0,
}


def _normalized(inputs: Mapping[str, Any]) -> dict[str, Any]:
    """Приводит входные данные к числам, заполняя пропуски значениями по умолчанию."""
    result = dict(DEFAULT_INPUTS)
    for key, value in (inputs or {}).items():
        if key in {"has_retargeting", "has_metrika", "has_goals"}:
            result[key] = bool(value)
        elif isinstance(value, bool):
            result[key] = value
        else:
            result[key] = to_float(value)
    return result


# ─── Основная функция ──────────────────────────────────────────

def generate_hypotheses(
    inputs: Mapping[str, Any],
    *,
    limit: int = 12,
    min_impressions: int = 300,
) -> HypothesisSet:
    """Собирает гипотезы под конкретного клиента.

    Порядок и приоритет зависят от того, что сильнее мешает зарабатывать:
    сначала спасаем деньги (боты, убыточные фразы), затем добираем трафик,
    затем улучшаем сайт и аудиторию.
    """
    data = _normalized(inputs)
    cards: list[HypothesisCard] = []
    notes: list[str] = []

    clicks = int(data["clicks"])
    impressions = int(data["impressions"])
    cost = data["cost_rub"]
    conversions = data["conversions"]
    target_cpa = data["target_cpa_rub"]
    daily_budget = data["daily_budget_rub"]
    cpa = safe_div(cost, conversions) if conversions > 0 else 0.0
    conversion_rate = percent(conversions, clicks) if clicks else 0.0
    cpc = round(safe_div(cost, clicks), 2)
    monthly_budget = money(daily_budget * 30) if daily_budget else money(cost * 30 / 14)

    if impressions < min_impressions:
        notes.append(
            f"Показов за период меньше {min_impressions} — часть выводов предварительная. "
            "Через неделю проверка станет точнее.",
        )

    # ─── 1. Боты: самая быстрая экономия без риска ─────────────
    bot_share = data["bot_share_pct"]
    if bot_share >= 10:
        impact = round(min(25.0, bot_share * 0.8), 1)
        cards.append(
            HypothesisCard(
                code="bots-filter",
                type=TYPE_TECH,
                title="Отключить ботовый трафик",
                description=(
                    f"{bot_share}% визитов — автоматические: они съедают часть бюджета и портят статистику. "
                    "Фильтр ботов в Метрике и исключение площадок убирают этот шум за один день."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=7,
                priority=_priority(impact, effort="easy", confidence="high", severity="critical"),
                confidence="high",
                action="Применить фильтр в разделе «Защита от ботов» и проверить статистику через неделю",
                metrics={"bot_share_pct": bot_share, "wasted_rub": money(data["bot_wasted_rub"])},
            ),
        )

    # ─── 2. Фразы без конверсий: не сливать, а переделать ──────
    no_conv = int(data["no_conversion_keywords"])
    if no_conv > 0:
        impact = round(min(20.0, 5.0 + no_conv * 1.5), 1)
        cards.append(
            HypothesisCard(
                code="minus-words",
                type=TYPE_CONVERSION,
                title=f"Почистить {no_conv} фраз(ы) без конверсий",
                description=(
                    "Эти фразы привлекли клики, но не дали заявок. Мы не выключаем их сразу: "
                    "сначала снижаем ставку и добавляем минус-слова — так видно, дело в фразе или в объявлении."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=10,
                priority=_priority(impact, effort="easy", confidence="medium", severity="critical"),
                confidence="medium",
                action="Собрать поисковые запросы без конверсий и добавить минус-слова",
                metrics={"keywords": no_conv},
            ),
        )

    # ─── 3. Ставки и цена конверсии ────────────────────────────
    if target_cpa > 0 and cpa > 0 and cpa > target_cpa * 1.2:
        overpay_pct = round((cpa / target_cpa - 1) * 100)
        impact = round(min(30.0, overpay_pct * 0.5), 1)
        cards.append(
            HypothesisCard(
                code="bids-to-target",
                type=TYPE_BUDGET,
                title="Подтянуть цену конверсии к цели",
                description=(
                    f"Сейчас конверсия стоит {money(cpa)} ₽, цель — {money(target_cpa)} ₽ (переплата {overpay_pct}%). "
                    "Пересчёт ставок по каждой фразе возвращает кампанию в план без потери объёма заявок."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=14,
                priority=_priority(impact, effort="easy", confidence="high", severity="warning"),
                confidence="high",
                action="Применить план ставок в разделе «Кампании» и следить за CPA неделю",
                metrics={"cpa_rub": money(cpa), "target_cpa_rub": money(target_cpa), "overpay_pct": overpay_pct},
            ),
        )
    elif target_cpa > 0 and cpa > 0:
        headroom = round((1 - cpa / target_cpa) * 100)
        cards.append(
            HypothesisCard(
                code="scale-winners",
                type=TYPE_BUDGET,
                title="Масштабировать то, что уже работает",
                description=(
                    f"Конверсия стоит {money(cpa)} ₽ при цели {money(target_cpa)} ₽ — есть запас {headroom}%. "
                    "Увеличение бюджета на 30% при такой экономике должно дать пропорциональный рост заявок."
                ),
                expected_impact_pct=round(min(30.0, headroom), 1),
                required_budget=money((monthly_budget or cost * 2) * 0.3),
                duration_days=14,
                priority=_priority(round(min(30.0, headroom), 1), effort="medium", confidence="medium", severity="info"),
                confidence="medium",
                action="Поднять дневной бюджет на 30% и следить за CPA каждые 3 дня",
                metrics={"cpa_rub": money(cpa), "target_cpa_rub": money(target_cpa)},
            ),
        )

    # ─── 4. Рост за счёт потерянных показов ───────────────────
    lost_share = data["lost_impression_share"]
    if lost_share >= 0.3:
        impact = round(min(35.0, lost_share * 40), 1)
        cards.append(
            HypothesisCard(
                code="lost-impressions",
                type=TYPE_TRAFFIC,
                title="Забрать потерянные показы",
                description=(
                    f"Из-за ставок и бюджета мы теряем {round(lost_share * 100)}% возможных показов. "
                    "Часть из них — целевые: их можно выкупить, подняв ставки по лучшим фразам."
                ),
                expected_impact_pct=impact,
                required_budget=money((monthly_budget or cost * 2) * 0.25),
                duration_days=14,
                priority=_priority(impact, effort="easy", confidence="medium", severity="warning"),
                confidence="medium",
                action="Поднять ставки по фразам с дешёвой конверсией (план готов в «Кампаниях»)",
                metrics={"lost_impression_share": round(lost_share * 100, 1)},
            ),
        )

    # ─── 5. Сайт: там, где конверсия теряется после клика ──────
    site_issues = int(data["site_issues"])
    if site_issues > 0 or data["site_score"] < 75:
        impact = round(min(30.0, 8.0 + site_issues * 4.0), 1)
        cards.append(
            HypothesisCard(
                code="site-fixes",
                type=TYPE_SITE,
                title="Убрать препятствия на сайте",
                description=(
                    f"Приложение нашло {site_issues} замечаний к посадочной странице "
                    f"(оценка {int(data['site_score'])}/100). Скорость загрузки и заголовок страницы влияют "
                    "и на цену клика, и на конверсию — это двойная выгода."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=10,
                priority=_priority(impact, effort="hard", confidence="medium", severity="warning"),
                confidence="medium",
                action="Открыть отчёт «Проверка сайта» и исправить замечания по приоритету",
                metrics={"site_score": int(data["site_score"]), "issues": site_issues},
            ),
        )

    # ─── 6. Конверсия приложения в заявку ─────────────────────
    if clicks >= 200 and conversion_rate < 2.0:
        impact = round(min(40.0, (2.5 - conversion_rate) * 12), 1)
        cards.append(
            HypothesisCard(
                code="landing-offer",
                type=TYPE_CONVERSION,
                title="Переписать предложение под спрос",
                description=(
                    f"Конверсия сайта {conversion_rate}% — на платном трафике это значит, что большая часть "
                    "кликов уходит впустую. Обычно помогает: оффер в первом экране, цена, сроки, кнопка связи."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=14,
                priority=_priority(impact, effort="hard", confidence="medium", severity="critical"),
                confidence="medium",
                action="Собрать 3 варианта первого экрана и протестировать по очереди (по неделе)",
                metrics={"conversion_rate_pct": conversion_rate, "clicks": clicks},
            ),
        )

    # ─── 7. Гео: где платим, а где зарабатываем ───────────────
    if int(data["regions_used"]) <= 1 and clicks >= 150:
        impact = 12.0
        cards.append(
            HypothesisCard(
                code="geo-split",
                type=TYPE_AUDIENCE,
                title="Разделить кампании по регионам",
                description=(
                    "Сейчас один регион в кампании. Разделение по городам даёт отдельный бюджет и ставки для каждого: "
                    "в Москве цена клика в 1.5–2 раза выше, чем в регионах, а смешивать их в одном бюджете невыгодно."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=14,
                priority=_priority(impact, effort="medium", confidence="medium", severity="info"),
                confidence="medium",
                action="Скопировать кампанию на 2–3 города и задать разные дневные бюджеты",
                metrics={"regions_used": int(data["regions_used"])},
            ),
        )

    # ─── 8. Ретаргетинг: тёплая аудитория почти всегда дешевле ─
    if not data["has_retargeting"] and clicks >= 100:
        impact = 18.0
        cards.append(
            HypothesisCard(
                code="retargeting",
                type=TYPE_AUDIENCE,
                title="Включить ретаргетинг",
                description=(
                    "Из тех, кто был на сайте, заявку оставил лишь каждый N-й — остальные ушли думать. "
                    "Возврат этих людей стоит в 2–3 раза дешевле нового клика из поиска."
                ),
                expected_impact_pct=impact,
                required_budget=money(max(3000.0, (monthly_budget or 30000) * 0.1)),
                duration_days=21,
                priority=_priority(impact, effort="medium", confidence="high", severity="info"),
                confidence="high",
                action="Включить сегмент «Были на сайте, но не оставили заявку» и дать ему отдельный бюджет",
                metrics={"clicks": clicks},
            ),
        )

    # ─── 9. Цели и аналитика: без них решения слепые ──────────
    if not data["has_goals"]:
        impact = 10.0
        cards.append(
            HypothesisCard(
                code="goals-setup",
                type=TYPE_TECH,
                title="Настроить цели в Метрике",
                description=(
                    "Цели пока не настроены — значит, ни движок, ни вы не видите, какие фразы приносят заявки. "
                    "Это фундамент: без целей оптимизация ставок превращается в угадывание."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=3,
                priority=_priority(impact, effort="easy", confidence="high", severity="critical"),
                confidence="high",
                action="Отметить в Метрике отправку формы и звонок как цели, затем повторить проверку",
                metrics={"has_goals": False},
            ),
        )

    # ─── 10. Расписание показов ───────────────────────────────
    if clicks >= 300 and conversions > 0 and data["mobile_share_pct"] >= 70:
        impact = 9.0
        cards.append(
            HypothesisCard(
                code="mobile-first",
                type=TYPE_SITE,
                title="Ускорить мобильную версию",
                description=(
                    f"{round(data['mobile_share_pct'])}% трафика — с телефонов. Скорость на мобильных напрямую "
                    "влияет и на процент отказов, и на позицию в аукционе Яндекса."
                ),
                expected_impact_pct=impact,
                required_budget=0.0,
                duration_days=14,
                priority=_priority(impact, effort="hard", confidence="medium", severity="info"),
                confidence="medium",
                action="Сжать картинки, включить кэширование, проверить LCP на телефоне",
                metrics={"mobile_share_pct": round(data["mobile_share_pct"], 1)},
            ),
        )

    # ─── Если данных мало ─────────────────────────────────────
    if not cards:
        notes.append(
            "Данных пока мало для уверенных гипотез: движок ждёт статистику хотя бы за 7–10 дней "
            "с показов не меньше 300.",
        )
        cards.append(
            HypothesisCard(
                code="collect-data",
                type=TYPE_TECH,
                title="Собрать статистику для точных решений",
                description=(
                    "Кампания только стартовала или подключена недавно. Первое, что стоит сделать — "
                    "убедиться, что цели Метрики считают заявки, и дать кампании неделю на набор статистики."
                ),
                expected_impact_pct=5.0,
                required_budget=0.0,
                duration_days=7,
                priority=60,
                confidence="high",
                action="Проверить цели Метрики и вернуться к гипотезам через неделю",
                metrics={"clicks": clicks, "impressions": impressions, "cost_rub": money(cost)},
            ),
        )

    cards.sort(key=lambda card: card.priority, reverse=True)
    return HypothesisSet(cards=cards[:limit], inputs=data, notes=notes)


def _priority(impact_pct: float, *, effort: str, confidence: str, severity: str) -> int:
    """Приоритет 0–100: эффект × уверенность ÷ сложность (+ срочность)."""
    effort_factor = {"easy": 1.2, "medium": 1.0, "hard": 0.75}.get(effort, 1.0)
    confidence_factor = {"high": 1.2, "medium": 1.0, "low": 0.8}.get(confidence, 1.0)
    severity_bonus = 12 if severity == "critical" else 5 if severity == "warning" else 0
    score = impact_pct * 2.4 * effort_factor * confidence_factor + severity_bonus
    return int(max(5, min(99, round(score))))


def from_findings(findings: Sequence[Mapping[str, Any]], base_inputs: Mapping[str, Any] | None = None) -> HypothesisSet:
    """Строит гипотезы из находок движка (детектор ботов, цена конверсии и т. д.).

    Нужна, когда данные уже собраны другими модулями: не нужно пересчитывать
    метрики заново — достаточно передать их находки.
    """
    inputs = dict(base_inputs or {})
    for finding in findings:
        code = str(finding.get("code", ""))
        impact = to_float(finding.get("impact_rub"))
        if code.startswith("bots:") and impact > 0:
            inputs.setdefault("bot_wasted_rub", impact)
    return generate_hypotheses(inputs)


__all__ = [
    "DEFAULT_DURATION_DAYS",
    "DEFAULT_INPUTS",
    "HypothesisCard",
    "HypothesisSet",
    "TYPE_AUDIENCE",
    "TYPE_BUDGET",
    "TYPE_CONVERSION",
    "TYPE_SITE",
    "TYPE_TECH",
    "TYPE_TRAFFIC",
    "from_findings",
    "generate_hypotheses",
]
