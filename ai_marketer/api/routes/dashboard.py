"""Главный экран: деньги, заявки, защита от ботов и что делать дальше.

Задача роута — собрать в один ответ всё, что показывает дашборд: баланс,
четыре метрики, состояние защиты от ботов, ожидающие гипотезы и совет.
Один запрос вместо пяти: приложение открывается мгновенно.

Сеть здесь не трогаем: живые проверки Директа и Метрики живут в своих
роутах, а дашборд читает то, что уже посчитано и сохранено. Иначе главный
экран зависел бы от скорости чужих API.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter
from sqlalchemy import select

from ai.advisor import advice_for_dashboard
from api.deps import CurrentUser, DbSession, ProfileDep
from core.config import settings
from core.logger import get_logger
from core.models import BotReport, Campaign, Hypothesis, ServiceConnection
from engine import to_float
from payments.balance import format_money, get_balance

log = get_logger(__name__)

router = APIRouter(prefix="/dashboard", tags=["дашборд"])

# Порог, с которого гипотеза считается приоритетной
PRIORITY_HIGH = 80


def _greeting(first_name: str | None) -> str:
    """Приветствие по времени суток — мелочь, а экран становится живым."""
    hour = datetime.now().hour
    if hour < 5:
        part = "Доброй ночи"
    elif hour < 12:
        part = "Доброе утро"
    elif hour < 18:
        part = "Добрый день"
    else:
        part = "Добрый вечер"
    return f"{part}, {first_name}!" if first_name else f"{part}!"


def _campaign_totals(campaigns: list[Campaign]) -> dict[str, float]:
    """Складывает сохранённую статистику кампаний в понятные числа."""
    clicks = sum(int(to_float((campaign.stats_cache or {}).get("clicks"))) for campaign in campaigns)
    impressions = sum(int(to_float((campaign.stats_cache or {}).get("impressions"))) for campaign in campaigns)
    conversions = sum(to_float((campaign.stats_cache or {}).get("conversions")) for campaign in campaigns)
    cost = sum(to_float((campaign.stats_cache or {}).get("cost_rub")) for campaign in campaigns)

    return {
        "clicks": clicks,
        "impressions": impressions,
        "conversions": round(conversions, 2),
        "cost_rub": round(cost, 2),
        "cpa_rub": round(cost / conversions, 2) if conversions else 0.0,
        "cpc_rub": round(cost / clicks, 2) if clicks else 0.0,
        "ctr": round(clicks / impressions * 100, 2) if impressions else 0.0,
        "conversion_rate": round(conversions / clicks * 100, 2) if clicks else 0.0,
        "daily_budget_rub": round(sum(to_float(campaign.daily_budget) for campaign in campaigns), 2),
    }


def _metrics(totals: dict[str, float], *, has_data: bool) -> list[dict[str, Any]]:
    """Четыре плитки метрик 2×2 — ровно как на макете."""
    if not has_data:
        return [
            {"key": "clicks", "title": "Клики", "value": 0, "text": "—", "unit": ""},
            {"key": "conversions", "title": "Заявки", "value": 0, "text": "—", "unit": ""},
            {"key": "cpa", "title": "Цена заявки", "value": 0.0, "text": "—", "unit": "₽"},
            {"key": "cost", "title": "Расход", "value": 0.0, "text": "—", "unit": "₽"},
        ]

    return [
        {"key": "clicks", "title": "Клики", "value": totals["clicks"], "text": f"{totals['clicks']:,}".replace(",", " "), "unit": ""},
        {
            "key": "conversions",
            "title": "Заявки",
            "value": totals["conversions"],
            "text": f"{totals['conversions']:.0f}".replace(".", ","),
            "unit": "",
        },
        {"key": "cpa", "title": "Цена заявки", "value": totals["cpa_rub"], "text": format_money(totals["cpa_rub"]), "unit": "₽"},
        {"key": "cost", "title": "Расход", "value": totals["cost_rub"], "text": format_money(totals["cost_rub"]), "unit": "₽"},
    ]


def _extra_metrics(totals: dict[str, float]) -> list[dict[str, Any]]:
    """Дополнительные показатели: CTR, цена клика, конверсия из клика."""
    return [
        {"key": "ctr", "title": "CTR", "value": totals["ctr"], "text": f"{totals['ctr']:.2f}%".replace(".", ",")},
        {"key": "cpc", "title": "Цена клика", "value": totals["cpc_rub"], "text": format_money(totals["cpc_rub"])},
        {
            "key": "conversion_rate",
            "title": "Клики в заявки",
            "value": totals["conversion_rate"],
            "text": f"{totals['conversion_rate']:.1f}%".replace(".", ","),
        },
    ]


def _hypothesis_view(row: Hypothesis) -> dict[str, Any]:
    """Короткая карточка гипотезы для главного экрана."""
    extra = dict(row.result or {})
    impact = to_float(extra.get("impact_rub"))
    return {
        "id": row.id,
        "code": row.code,
        "title": row.title,
        "description": row.description or "",
        "type": row.type,
        "priority": row.priority,
        "status": row.status,
        "expected_impact_pct": round(float(row.expected_impact_pct or 0.0), 1),
        "impact_rub": round(impact, 2),
        "impact_text": format_money(impact),
        "action": extra.get("action") or "",
    }


async def _dashboard_context(session: DbSession, user: CurrentUser, profile: ProfileDep) -> dict[str, Any]:
    """Считает все числа главного экрана. Один расчёт переиспользуют два роута."""
    campaigns_result = await session.execute(
        select(Campaign).where(Campaign.user_id == user.id).order_by(Campaign.updated_at.desc()),
    )
    campaigns = list(campaigns_result.scalars().all())
    totals = _campaign_totals(campaigns)
    has_data = totals["clicks"] > 0

    balance = await get_balance(session, user)
    planned_monthly = to_float(profile.monthly_budget_rub)
    period_days = int(to_float((campaigns[0].stats_cache or {}).get("period_days"))) if campaigns else 30
    period_days = period_days or 30
    daily_spend = round(totals["cost_rub"] / max(period_days, 1), 2)
    daily_plan = round(planned_monthly / 30, 2) if planned_monthly else round(daily_spend, 2)
    target_cpa = to_float(profile.target_cpa_rub)
    projected_leads = round(daily_plan * 30 / target_cpa, 1) if target_cpa > 0 else 0.0

    report_result = await session.execute(
        select(BotReport).where(BotReport.user_id == user.id).order_by(BotReport.created_at.desc()).limit(1),
    )
    report = report_result.scalar_one_or_none()
    report_data = dict(report.report_data or {}) if report is not None else {}
    risk_score = int(to_float(report_data.get("risk_score")))
    wasted = to_float(report_data.get("wasted_rub"))
    savings = to_float(report_data.get("monthly_savings_rub"))

    hypotheses_result = await session.execute(
        select(Hypothesis)
        .where(Hypothesis.user_id == user.id, Hypothesis.status == "pending")
        .order_by(Hypothesis.priority.desc())
        .limit(20),
    )
    hypotheses = list(hypotheses_result.scalars().all())
    hypotheses_impact = sum(to_float((row.result or {}).get("impact_rub")) for row in hypotheses)

    connections_result = await session.execute(
        select(ServiceConnection).where(ServiceConnection.user_id == user.id, ServiceConnection.is_active.is_(True)),
    )
    connections = {row.service_type: row for row in connections_result.scalars().all()}
    direct_row = connections.get("yandex_direct")
    metrika_row = connections.get("yandex_metrika")

    # Ключи совпадают с теми, что ждёт шаблон и подсказка для модели:
    # так совет не превращается в набор нулей из-за разного названия одного поля
    advice_context = {
        "balance_rub": balance,
        "planned_monthly_rub": planned_monthly,
        "monthly_budget_rub": planned_monthly,
        "daily_plan_rub": daily_plan,
        "daily_spend_rub": daily_spend,
        "cost_rub": totals["cost_rub"],
        "clicks": totals["clicks"],
        "conversions": totals["conversions"],
        "cpa_rub": totals["cpa_rub"],
        "average_cpa_rub": totals["cpa_rub"],
        "target_cpa_rub": target_cpa,
        "projected_leads": projected_leads,
        "projected_leads_per_month": projected_leads,
        "wasted_rub": wasted,
        "saved_rub": savings,
        "monthly_savings_rub": savings,
        "risk_score": risk_score,
        "hypotheses": len(hypotheses),
        "hypotheses_impact_rub": round(hypotheses_impact, 2),
        "campaigns_active": sum(1 for campaign in campaigns if campaign.status == "active"),
        "campaigns_total": len(campaigns),
    }

    return {
        "campaigns": campaigns,
        "totals": totals,
        "has_data": has_data,
        "balance": balance,
        "planned_monthly": planned_monthly,
        "daily_spend": daily_spend,
        "daily_plan": daily_plan,
        "target_cpa": target_cpa,
        "projected_leads": projected_leads,
        "report": report,
        "report_data": report_data,
        "risk_score": risk_score,
        "wasted": wasted,
        "savings": savings,
        "hypotheses": hypotheses,
        "hypotheses_impact": hypotheses_impact,
        "direct_row": direct_row,
        "metrika_row": metrika_row,
        "advice_context": advice_context,
    }


@router.get("", summary="Сводка для главного экрана")
async def dashboard(session: DbSession, user: CurrentUser, profile: ProfileDep) -> dict[str, Any]:
    """Всё для главного экрана одним запросом."""
    data = await _dashboard_context(session, user, profile)
    totals = data["totals"]
    hypotheses = data["hypotheses"]

    advice = await advice_for_dashboard(data["advice_context"], client=None, user_name=user.first_name or "")

    return {
        "user": {
            "id": user.id,
            "tg_id": user.tg_id,
            "first_name": user.first_name or "",
            "last_name": user.last_name or "",
            "username": user.username or "",
            "balance": round(data["balance"], 2),
            "balance_text": format_money(data["balance"]),
            "onboarding_completed": user.onboarding_completed,
        },
        "greeting": _greeting(user.first_name),
        "money": {
            "balance_rub": round(data["balance"], 2),
            "balance_text": format_money(data["balance"]),
            "planned_monthly_rub": round(data["planned_monthly"], 2),
            "daily_plan_rub": data["daily_plan"],
            "spent_rub": totals["cost_rub"],
            "spent_text": format_money(totals["cost_rub"]),
            "daily_spend_rub": data["daily_spend"],
            "daily_spend_text": format_money(data["daily_spend"]),
            "saved_rub": round(data["savings"], 2),
            "saved_text": format_money(data["savings"]),
            "wasted_rub": round(data["wasted"], 2),
            "wasted_text": format_money(data["wasted"]),
            "projected_leads_per_month": data["projected_leads"],
            "days_left": round(data["balance"] / data["daily_spend"], 1) if data["daily_spend"] > 0 else None,
        },
        "metrics": _metrics(totals, has_data=data["has_data"]),
        "extra_metrics": _extra_metrics(totals),
        "totals": totals,
        "bot_shield": {
            "risk_score": data["risk_score"],
            "risk_level": _risk_level(data["risk_score"]),
            "wasted_rub": round(data["wasted"], 2),
            "saved_rub": round(data["savings"], 2),
            "saved_text": format_money(data["savings"]),
            "has_report": data["report"] is not None,
            "report_id": data["report"].id if data["report"] is not None else None,
            "checked_at": data["report"].created_at.isoformat() if data["report"] is not None and data["report"].created_at else None,
            "suspicious_visits": int(to_float(data["report_data"].get("suspicious_visits"))),
            "total_visits": int(to_float(data["report_data"].get("total_visits"))),
            "patterns": (data["report_data"].get("patterns") or [])[:4],
            "summary": data["report"].ai_summary if data["report"] is not None else None,
        },
        "hypotheses": {
            "pending": len(hypotheses),
            "impact_rub": round(data["hypotheses_impact"], 2),
            "impact_text": format_money(data["hypotheses_impact"]),
            "top": [_hypothesis_view(row) for row in hypotheses[:3]],
        },
        "advice": advice.to_dict(),
        "direct": _connection_state(data["direct_row"], "Яндекс.Директ"),
        "metrika": _connection_state(data["metrika_row"], "Яндекс.Метрика"),
        "profile": profile.to_dict(),
        "limits": {
            "sbp_configured": settings.sbp_enabled,
            "ai_enabled": bool(
                (settings.OPENROUTER_API_KEY or "").strip()
                and not (settings.OPENROUTER_API_KEY or "").startswith("sk-or-v1-xxx")
            ),
        },
    }


def _risk_level(score: int) -> str:
    """Словесная оценка риска: понятнее, чем просто число."""
    if score >= 70:
        return "высокий"
    if score >= 40:
        return "средний"
    if score > 0:
        return "низкий"
    return "нет данных"


def _connection_state(row: ServiceConnection | None, title: str) -> dict[str, Any]:
    """Состояние подключения без обращения к сети: из сохранённых данных."""
    if row is None:
        return {"connected": False, "title": title, "message": f"{title} не подключён", "details": {}}
    details = dict(row.metadata_json or {})
    return {
        "connected": True,
        "title": title,
        "is_active": row.is_active,
        "checked_at": row.last_checked_at.isoformat() if row.last_checked_at else None,
        "error": row.last_error,
        "message": row.last_error or "Подключение работает",
        "details": {
            key: details.get(key)
            for key in ("login", "counter_id", "counter_name", "site_url", "platform", "campaigns", "goals", "token_masked")
            if details.get(key) is not None
        },
    }


@router.get("/advice", summary="Совет от AI-советника")
async def advice(session: DbSession, user: CurrentUser, profile: ProfileDep) -> dict[str, Any]:
    """Совет отдельным запросом: экран не ждёт ответа OpenRouter."""
    from ai.advisor import build_client

    data = await _dashboard_context(session, user, profile)
    client = build_client(settings)
    try:
        result = await advice_for_dashboard(data["advice_context"], client=client, user_name=user.first_name or "")
    finally:
        await client.close()

    return result.to_dict()


@router.get("/summary", summary="Короткая сводка для сообщений бота")
async def summary(session: DbSession, user: CurrentUser, profile: ProfileDep) -> dict[str, Any]:
    """Строка-сводка, которую бот присылает в чат."""
    data = await _dashboard_context(session, user, profile)
    totals = data["totals"]

    lines = [
        f"💰 Баланс: {format_money(data['balance'])}",
        f"📉 Расход за {REPORT_PERIOD_DAYS_TEXT}: {format_money(totals['cost_rub'])}",
        f"🎯 Заявок: {totals['conversions']:.0f}",
    ]
    if totals["cpa_rub"]:
        target = data["target_cpa"]
        tail = f" (цель {format_money(target)})" if target else ""
        lines.append(f"📊 Цена заявки: {format_money(totals['cpa_rub'])}{tail}")
    if data["savings"]:
        lines.append(f"🛡 Экономия на ботах: {format_money(data['savings'])} в месяц")
    if data["hypotheses"]:
        lines.append(f"💡 Гипотез в работе: {len(data['hypotheses'])} на {format_money(data['hypotheses_impact'])}")

    return {
        "text": "\n".join(lines),
        "totals": totals,
        "balance_text": format_money(data["balance"]),
        "has_data": data["has_data"],
    }


REPORT_PERIOD_DAYS_TEXT = "30 дней"

__all__ = ["router"]
