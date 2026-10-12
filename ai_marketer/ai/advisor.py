"""AI-советник: превращает расчёты движка в человеческий текст.

Границы ответственности жёсткие:

  • движок (пакет engine) считает цифры и сам решает, что делать;
  • советник только пересказывает это решение владельцу бизнеса понятным
    языком — без новых чисел, без своих рекомендаций, без «а я думаю».

Если ключа нет, модель недоступна или в ответе появилось число, которого
нет в расчётах, — возвращается шаблонный текст, собранный из тех же самых
цифр. Поэтому экран никогда не пустует, а клиент никогда не видит
выдуманных сумм.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from core.logger import get_logger
from engine import money, percent, to_float
from ai.openrouter_client import OpenRouterClient, OpenRouterError, numbers_are_grounded

log = get_logger(__name__)

# Кто такой советник и чего ему нельзя — это самая важная часть запроса
SYSTEM_PROMPT = (
    "Ты — маркетолог, который объясняет владельцу малого бизнеса результаты расчётов. "
    "Тебе дают готовые цифры и готовый список действий, посчитанные программой. "
    "Правила: 1) не придумывай новых чисел — используй только те, что даны; "
    "2) не придумывай новых действий — только те, что в списке; "
    "3) пиши 2–3 предложения живым языком, обращение на «вы»; "
    "4) без markdown, заголовков, списков и вступлений вроде «Конечно!»; "
    "5) не обещай гарантированный результат — говори «оценка», «примерно», «по расчётам»."
)

MAX_HYPOTHESES_IN_PROMPT = 3
CHARS_LIMIT = 700


@dataclass(slots=True)
class Advice:
    """Готовый текст для экрана: от ИИ или шаблонный, но всегда с числами движка."""

    text: str
    source: str  # ai | template
    model: str | None = None
    reason: str | None = None
    generated_at: str = ""

    def __post_init__(self) -> None:
        if not self.generated_at:
            self.generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "source": self.source,
            "model": self.model,
            "reason": self.reason,
            "generated_at": self.generated_at,
        }


# ──────────────────────────── Клиент ────────────────────────────


def build_client(settings: Any = None) -> OpenRouterClient:
    """Создаёт клиент ИИ из настроек проекта (secrets.env)."""
    if settings is None:
        from core.config import get_settings

        settings = get_settings()

    return OpenRouterClient(
        api_key=str(getattr(settings, "OPENROUTER_API_KEY", "") or ""),
        model=str(getattr(settings, "AI_MODEL", "") or "") or "meta-llama/llama-3.3-70b-instruct:free",
        site_url=str(getattr(settings, "WEBAPP_URL", "") or ""),
    )


def _money(value: Any) -> str:
    """Деньги в формате «8 930 ₽» — как в приложении."""
    amount = money(to_float(value))
    text = f"{amount:,.0f}".replace(",", " ")
    return f"{text} ₽"


# ──────────────────────────── Главный путь ────────────────────────────


async def _ask(
    client: OpenRouterClient | None,
    *,
    facts: Mapping[str, Any],
    user_prompt: str,
    template: str,
) -> Advice:
    """Общий сценарий: спросить ИИ → проверить числа → иначе шаблон.

    Так один и тот же порядок проверок работает для всех экранов, и ни один
    из них не может показать выдуманные цифры.
    """
    if client is None or not client.enabled:
        return Advice(text=template, source="template", reason="ИИ не подключён — текст собран из расчётов")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    try:
        text, model = await client.chat_with_fallback(messages)
    except OpenRouterError as error:
        log.warning("ИИ недоступен — отдаю шаблонный текст", reason=str(error)[:160])
        return Advice(text=template, source="template", reason=str(error)[:200])

    if not numbers_are_grounded(text, facts):
        return Advice(
            text=template,
            source="template",
            reason="Ответ модели содержал числа, которых нет в расчётах",
        )

    return Advice(text=text, source="ai", model=model)


# ──────────────────────────── Дашборд ────────────────────────────


def dashboard_template(context: Mapping[str, Any]) -> str:
    """Текст без ИИ: те же выводы, но собранные из расчётов.

    Числа держим отдельно от текста: сначала сравнения, потом оформление.
    Так шаблон не сломается от того, что в сумму добавился знак рубля.
    """
    savings_value = to_float(context.get("monthly_savings_rub", 0))
    lost_value = to_float(context.get("wasted_rub", 0))
    cpa_value = to_float(context.get("average_cpa_rub", 0))
    target_value = to_float(context.get("target_cpa_rub", 0))
    conversions = to_float(context.get("conversions", 0))
    budget_value = to_float(context.get("monthly_budget_rub", 0))

    parts: list[str] = []
    if lost_value > 0:
        parts.append(
            f"При бюджете {_money(budget_value)} в месяц около {_money(lost_value)} уходит на ботовый трафик."
        )
    if target_value > 0 and cpa_value > 0:
        if cpa_value > target_value:
            parts.append(f"Средняя заявка стоит {_money(cpa_value)} при цели {_money(target_value)} — есть что подтянуть.")
        else:
            parts.append(
                f"Средняя заявка стоит {_money(cpa_value)} — это дешевле цели {_money(target_value)}, "
                "значит можно забирать больше трафика."
            )
    if savings_value > 0:
        parts.append(f"Резерв в расчётах — около {_money(savings_value)} в месяц: эти деньги можно вернуть.")
    if conversions > 0:
        parts.append(f"За период пришло {conversions:.0f} заявок.")
    leads = to_float(context.get("projected_leads_per_month", 0))
    if leads > 0:
        parts.append(f"При текущем бюджете это примерно {leads:.0f} заявок в месяц.")
    if not parts:
        parts.append("Данных пока мало: как только наберётся статистика, здесь появятся выводы и суммы.")
    return " ".join(parts[:3])


async def advice_for_dashboard(
    context: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
    user_name: str = "",
) -> Advice:
    """Совет на главном экране: 2–3 предложения о самом важном."""
    template = dashboard_template(context)
    facts = dict(context)
    prompt = (
        f"Владельца зовут {user_name or 'предприниматель'}. Вот расчёты по его рекламе в Яндекс.Директе "
        f"(JSON):\n{_as_json(facts)}\n\n"
        "Объясни в 2–3 предложениях главное: сколько денег теряется или экономится и что важнее всего сделать. "
        "Не добавляй чисел, которых нет выше."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Отчёт о ботах ────────────────────────────


def bot_report_template(report: Mapping[str, Any]) -> str:
    """Саммари отчёта детектора ботов без ИИ."""
    suspicious = int(to_float(report.get("suspicious_visits", 0)))
    total = int(to_float(report.get("total_visits", 0)))
    share = to_float(report.get("suspicious_share_pct", 0)) or percent(suspicious, total)
    wasted_value = to_float(report.get("wasted_rub", 0))
    savings_value = to_float(report.get("monthly_savings_rub", 0))
    risk = int(to_float(report.get("risk_score", 0)))

    if suspicious == 0:
        return (
            f"За период проверено {total} визитов — подозрительных не найдено, риск {risk} из 100. "
            "Трафик выглядит живым: продолжайте следить за показателями, проверка идёт автоматически."
        )

    patterns = report.get("patterns") or []
    top_pattern = ""
    if patterns:
        first = patterns[0]
        top_pattern = str(first.get("title") or first.get("code") or "")

    text = (
        f"Из {total} визитов {suspicious} ({share:.1f}%) выглядят как боты — риск {risk} из 100. "
        f"На них ушло около {_money(wasted_value)}."
    )
    if top_pattern:
        text += f" Главный признак — «{top_pattern}»."
    if savings_value > 0:
        text += f" Если закрыть эти источники, за месяц вернётся примерно {_money(savings_value)}."
    return text


async def summarize_bot_report(
    report: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Человеческое объяснение отчёта BotShield."""
    template = bot_report_template(report)
    facts = dict(report)
    patterns = [
        {"title": item.get("title"), "visits": item.get("visits"), "share_pct": item.get("share_pct"), "money": item.get("wasted_rub")}
        for item in (report.get("patterns") or [])[:3]
    ]
    prompt = (
        "Вот результат проверки трафика на ботов (JSON):\n"
        f"{_as_json({'всего визитов': report.get('total_visits'), 'подозрительных': report.get('suspicious_visits'), 'доля %': report.get('suspicious_share_pct'), 'потеряно рублей': report.get('wasted_rub'), 'экономия в месяц': report.get('monthly_savings_rub'), 'риск': report.get('risk_score'), 'признаки': patterns})}\n\n"
        "Объясни владельцу простыми словами, что происходит и что это значит для его денег. "
        "2–3 предложения, без новых чисел."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Гипотезы ────────────────────────────


def hypothesis_template(card: Mapping[str, Any]) -> str:
    """Объяснение одной гипотезы без ИИ."""
    title = str(card.get("title") or "Гипотеза роста")
    impact = to_float(card.get("impact_pct", 0))
    effect_value = to_float(card.get("expected_effect_rub", 0) or card.get("monthly_effect_rub", 0))
    action = str(card.get("action") or "")
    description = str(card.get("description") or "")

    text = f"{title}: по расчётам даёт около {impact:.1f}% роста."
    if effect_value > 0:
        text += f" Это примерно {_money(effect_value)} в месяц."
    if description:
        text += f" {description}"
    if action:
        text += f" Что сделать: {action}."
    return text


async def explain_hypothesis(
    card: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Короткое объяснение: почему гипотеза работает и что она даёт."""
    template = hypothesis_template(card)
    facts = dict(card)
    prompt = (
        "Готовая гипотеза роста (JSON), посчитанная программой:\n"
        f"{_as_json({key: card.get(key) for key in ('title', 'description', 'action', 'impact_pct', 'expected_effect_rub', 'priority', 'type')})}\n\n"
        "Объясни владельцу в 2 предложениях, почему это сработает и что нужно сделать. "
        "Не добавляй чисел и действий, которых нет выше."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Отчёт по сайту ────────────────────────────


def site_template(seo: Mapping[str, Any]) -> str:
    """Вывод по проверке сайта без ИИ."""
    score = int(to_float(seo.get("score", 0)))
    issues = len(seo.get("findings") or [])
    critical = sum(1 for finding in (seo.get("findings") or []) if finding.get("severity") == "critical")
    facts = seo.get("facts") or {}

    if score >= 80:
        text = f"Сайт в хорошей форме: оценка {score} из 100, замечаний — {issues}."
    elif score >= 50:
        text = f"Сайт рабочий, но мешает конверсии: оценка {score} из 100, замечаний — {issues}."
    else:
        text = f"Сайт теряет заявки: оценка {score} из 100, замечаний — {issues}."

    if critical:
        text += f" Критичных проблем — {critical}, с них и стоит начать."
    load_ms = facts.get("response_ms")
    if load_ms:
        text += f" Страница отвечает за {int(to_float(load_ms))} мс."
    return text


async def summarize_site_audit(
    seo: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Объяснение проверки сайта: что мешает продавать."""
    template = site_template(seo)
    findings = [
        {"title": item.get("title"), "severity": item.get("severity"), "action": item.get("action")}
        for item in (seo.get("findings") or [])[:4]
    ]
    facts = {"score": seo.get("score"), "facts": seo.get("facts"), "findings": findings}
    prompt = (
        "Проверка сайта клиента (JSON):\n"
        f"{_as_json({'оценка': seo.get('score'), 'факты': seo.get('facts'), 'замечания': findings})}\n\n"
        "Объясни в 2–3 предложениях, что мешает сайту приносить заявки и с чего начать. "
        "Используй только замечания из списка."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Гео и рынок ────────────────────────────


def geo_template(geo: Mapping[str, Any]) -> str:
    """Выводы по регионам без ИИ."""
    summary = geo.get("summary") or {}
    advices = geo.get("advices") or []
    text = (
        f"Проверено {int(to_float(summary.get('regions_total', len(advices))))} регионов, "
        f"средняя заявка стоит {_money(summary.get('average_cpa_rub', 0))}."
    )
    paused = [item for item in advices if item.get("action") == "pause"]
    increased = [item for item in advices if item.get("action") == "increase"]
    if paused:
        names = ", ".join(str(item.get("region_name")) for item in paused[:3])
        text += f" В регионах ({names}) реклама убыточна — предложено остановить."
    if increased:
        names = ", ".join(str(item.get("region_name")) for item in increased[:3])
        text += f" В регионах ({names}) заявка дешевле цели — можно поднять ставки."
    if summary.get("potential_savings_rub"):
        text += f" Экономия по расчётам — {_money(summary.get('potential_savings_rub'))} ₽."
    return text


async def summarize_geo(
    geo: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Объяснение гео-корректировок."""
    template = geo_template(geo)
    facts = dict(geo)
    advices = [
        {"регион": item.get("region_name"), "действие": item.get("action"), "причина": item.get("reason"), "cpa": item.get("cpa_rub")}
        for item in (geo.get("advices") or [])[:5]
    ]
    prompt = (
        "Гео-анализ рекламы (JSON):\n"
        f"{_as_json({'итоги': geo.get('summary'), 'решения': advices})}\n\n"
        "Объясни в 2–3 предложениях, где реклама работает, а где деньги уходят зря. "
        "Решения уже приняты программой — просто перескажи их."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


def market_template(market: Mapping[str, Any]) -> str:
    """Вывод по рынку без ИИ."""
    cpc_value = to_float(market.get("market_cpc_rub", 0))
    yours_value = to_float(market.get("your_cpc_rub", 0))
    niche = str(market.get("niche_name") or market.get("niche") or "ваша ниша")
    competition = str(market.get("competition") or "")

    text = f"В нише «{niche}» средний клик стоит {_money(cpc_value)}"
    if competition:
        text += f", конкуренция — {competition}"
    text += "."
    if yours_value <= 0:
        text += " Это ориентир: если ваш клик дешевле — вы в выигрыше, если дороже — есть что оптимизировать."
    else:
        gap = to_float(market.get("gap_pct", 0))
        if gap > 5:
            text += f" У вас клик дороже рынка на {gap:.1f}% — стоит выровнять."
        elif gap < -5:
            text += f" У вас клик дешевле рынка на {abs(gap):.1f}% — можно забирать больше трафика."
    best = market.get("best_scenario") or {}
    if best.get("conversions"):
        text += f" При текущем бюджете реалистично {to_float(best['conversions']):.0f} заявок в месяц."
    return text


async def market_advice(
    market: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Объяснение рыночных ориентиров."""
    template = market_template(market)
    facts = dict(market)
    prompt = (
        "Оценка рынка для клиента (JSON):\n"
        f"{_as_json({'ниша': market.get('niche_name'), 'средний клик рынка': market.get('market_cpc_rub'), 'ваш клик': market.get('your_cpc_rub'), 'разница %': market.get('gap_pct'), 'конкуренция': market.get('competition'), 'лучший сценарий': market.get('best_scenario'), 'план бюджета': market.get('budget_plan')})}\n\n"
        "Объясни владельцу в 2–3 предложениях, как его показатели выглядят на фоне рынка и что это значит."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Недельный отчёт ────────────────────────────


def weekly_template(context: Mapping[str, Any]) -> str:
    """Недельный отчёт без ИИ — то, что бот присылает в Telegram."""
    period = str(context.get("period_label") or "за неделю")
    clicks = int(to_float(context.get("clicks", 0)))
    conversions = to_float(context.get("conversions", 0))
    cost_value = to_float(context.get("cost_rub", 0))
    cpa_value = to_float(context.get("cpa_rub", 0))
    bots = int(to_float(context.get("suspicious_visits", 0)))
    savings_value = to_float(context.get("monthly_savings_rub", 0))

    text = f"{period.capitalize()}: {clicks} кликов, {conversions:.0f} заявок, расход {_money(cost_value)}"
    if cpa_value > 0:
        text += f", цена заявки {_money(cpa_value)}"
    text += "."
    if bots:
        text += f" Подозрительных визитов — {bots}, их стоит проверить."
    if savings_value > 0:
        text += f" Гипотезы роста обещают около {_money(savings_value)} в месяц."
    return text


async def weekly_report(
    context: Mapping[str, Any],
    *,
    client: OpenRouterClient | None = None,
) -> Advice:
    """Текст для уведомления в Telegram (короткий, читается с телефона)."""
    template = weekly_template(context)
    facts = dict(context)
    prompt = (
        "Итоги недели по рекламе (JSON):\n"
        f"{_as_json({key: context.get(key) for key in ('period_label', 'clicks', 'impressions', 'conversions', 'cost_rub', 'cpa_rub', 'suspicious_visits', 'monthly_savings_rub')})}\n\n"
        "Напиши 2–3 предложения для уведомления в Telegram: что произошло и на что обратить внимание. "
        "Только факты из данных выше."
    )
    return await _ask(client, facts=facts, user_prompt=prompt, template=template)


# ──────────────────────────── Утилиты ────────────────────────────


def _as_json(value: Any) -> str:
    """Компактный JSON для запроса: без лишних пробелов и хвостов."""
    import json

    try:
        return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))[:4000]
    except (TypeError, ValueError):
        return "{}"


def advice_payload(items: Sequence[Advice]) -> list[dict[str, Any]]:
    """Список советов в виде словарей — для ответа API."""
    return [item.to_dict() for item in items]


__all__ = [
    "CHARS_LIMIT",
    "SYSTEM_PROMPT",
    "Advice",
    "advice_for_dashboard",
    "advice_payload",
    "bot_report_template",
    "build_client",
    "dashboard_template",
    "explain_hypothesis",
    "geo_template",
    "hypothesis_template",
    "market_advice",
    "market_template",
    "site_template",
    "summarize_bot_report",
    "summarize_geo",
    "summarize_site_audit",
    "weekly_report",
    "weekly_template",
]
