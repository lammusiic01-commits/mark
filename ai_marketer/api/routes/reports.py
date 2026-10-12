"""Отчёты: защита от ботов, гипотезы, аудит сайта, география и рынок.

Здесь приложение получает всё, что посчитал движок. Сама логика расчётов
живёт в engine/*, этот роут её вызывает, складывает результат в базу и
отдаёт наружу. AI-советник добавляет к числам человеческий текст — если он
недоступен, приходит шаблон с теми же цифрами.

Правило: ничего не выдумываем. Если данных нет (не подключена Метрика или
Директ), приходит понятная подсказка, а не нулевой отчёт.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from ai.advisor import explain_hypothesis, market_advice, summarize_bot_report, summarize_geo, summarize_site_audit
from api.deps import (
    CurrentUser,
    DbSession,
    OptionalDirectClientDep,
    OptionalMetrikaClientDep,
    ProfileDep,
    SiteUrlDep,
)
from core.logger import get_logger
from core.models import BotReport, Hypothesis
from engine import bot_detector, geo_analyzer, hypothesis_engine, market_analyzer, seo_analyzer, to_float
from payments.balance import format_money
from services.hosting import SiteError, build_passport, detect_platform, fetch_page
from services.yandex_direct import DirectError, attach_visit_costs
from services.yandex_metrika import MetrikaError

log = get_logger(__name__)

router = APIRouter(prefix="/reports", tags=["отчёты"])

# Период отчётов: месяц — привычный горизонт для рекламных решений
REPORT_PERIOD_DAYS = 30
# Порог, ниже которого выводы считаются предварительными
MIN_IMPRESSIONS_FOR_HYPOTHESES = 300
# Группы гипотез по приоритету
PRIORITY_HIGH = 80
PRIORITY_MEDIUM = 50


def _period(days: int = REPORT_PERIOD_DAYS) -> tuple[str, str]:
    """Даты периода отчёта: от (сегодня − дни) до сегодня."""
    today = date.today()
    return (today - timedelta(days=days - 1)).isoformat(), today.isoformat()


def _signed_money(value: float) -> str:
    """Деньги со знаком: «−2 500 ₽» читается понятнее, чем «-2500.0». """
    return format_money(value) if value >= 0 else f"−{format_money(abs(value))}"


def _money(value: Any) -> str:
    return format_money(to_float(value))


def _load_json(payload: Any, default: Any) -> Any:
    """Аккуратно читает поле, которое может прийти строкой JSON."""
    if payload in (None, "", b""):
        return default
    if isinstance(payload, (dict, list)):
        return payload
    try:
        return json.loads(str(payload))
    except (TypeError, ValueError):
        return default


async def _safe_call(coro: Any, *, default: Any, label: str) -> Any:
    """Выполняет запрос к внешнему сервису, не роняя весь отчёт.

    Если Директ или Метрика не ответили, отчёт собирается на том, что есть:
    пользователь увидит результат и предупреждение, а не пустой экран.
    """
    try:
        return await coro
    except (DirectError, MetrikaError) as error:
        log.warning("Часть данных недоступна", part=label, reason=str(error)[:160])
        return default
    except Exception as error:  # noqa: BLE001 — чужая сеть падает как угодно
        log.warning("Часть данных недоступна", part=label, reason=str(error)[:160])
        return default


async def _gather_visits(
    metrika: Any,
    direct: Any,
    *,
    date_from: str,
    date_to: str,
    reason: str,
) -> list[dict[str, Any]]:
    """Данные Метрики, обогащённые ценой клика из Директа.

    Метрика знает визиты, но не знает денег; Директ знает расход, но не знает
    визитов. Соединяем — только так утечка считается в рублях, а не в штуках.
    """
    if metrika is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)

    visits = await _safe_call(
        metrika.visits(date_from=date_from, date_to=date_to),
        default=None,
        label="визиты Метрики",
    )
    if visits is None:
        # Повторная попытка: выгрузка визитов — самая долгая операция API
        visits = await _safe_call(
            metrika.visits(date_from=date_from, date_to=date_to),
            default=[],
            label="повторная выгрузка визитов",
        )

    rows = list(visits or [])
    if direct is not None and rows:
        campaign_stats = await _safe_call(
            direct.campaign_statistics(date_from=date_from, date_to=date_to),
            default=[],
            label="статистика кампаний",
        )
        if campaign_stats:
            rows = attach_visit_costs(rows, campaign_stats)

    return rows


def _regions_from_visits(visits: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Складывает визиты по городам — вход для геоанализа."""
    buckets: dict[int, dict[str, Any]] = {}
    for visit in visits:
        try:
            code = int(to_float(visit.get("region_code")))
        except (TypeError, ValueError):
            code = 0
        if not code:
            continue
        bucket = buckets.setdefault(
            code,
            {"region_code": code, "clicks": 0, "cost_rub": 0.0, "conversions": 0.0, "impressions": 0},
        )
        bucket["clicks"] += 1
        bucket["cost_rub"] += to_float(visit.get("cost_rub"))
        bucket["conversions"] += to_float(visit.get("conversions"))
    return [buckets[code] for code in sorted(buckets, key=lambda item: -buckets[item]["cost_rub"])]


# ────────────────────────────── Детектор ботов ──────────────────────────────


def _bot_totals(report_data: Mapping[str, Any]) -> dict[str, float]:
    """Ключевые числа отчёта — в одном месте, чтобы не расходились."""
    return {
        "total_visits": to_float(report_data.get("total_visits")),
        "suspicious_visits": to_float(report_data.get("suspicious_visits")),
        "suspicious_share_pct": to_float(report_data.get("suspicious_share_pct")),
        "wasted_rub": to_float(report_data.get("wasted_rub")),
        "monthly_savings_rub": to_float(report_data.get("monthly_savings_rub")),
        "risk_score": to_float(report_data.get("risk_score")),
    }


@router.post("/bots", summary="Проверить трафик на ботов")
async def bots_report(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    metrika: OptionalMetrikaClientDep,
    direct: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Считает, сколько денег утекает на накрутку, и сохраняет отчёт.

    Источник — Метрика (визиты, источники, цели) плюс цены клика из Директа.
    Цифры считает движок, текст для человека — AI-советник.
    """
    date_from, date_to = _period()
    visits = await _gather_visits(
        metrika,
        direct,
        date_from=date_from,
        date_to=date_to,
        reason="Для отчёта нужна Метрика — подключите счётчик на экране «Подключения»",
    )

    report = bot_detector.detect_bots(
        visits,
        days=REPORT_PERIOD_DAYS,
        conversion_price_rub=to_float(profile.target_cpa_rub),
    )
    payload = report.to_dict()
    payload["period_from"] = date_from
    payload["period_to"] = date_to
    payload["profile"] = {"niche": profile.niche, "region_code": profile.region_code}

    advice = await summarize_bot_report(payload, client=None)
    payload["summary"] = advice.text
    payload["summary_source"] = advice.source
    payload["savings_text"] = _money(to_float(payload.get("monthly_savings_rub")))

    row = BotReport(
        user_id=user.id,
        period_from=date_from,
        period_to=date_to,
        report_data=payload,
        ai_summary=advice.text,
    )
    session.add(row)
    await session.flush()
    await session.commit()

    totals = _bot_totals(payload)
    log.info(
        "Отчёт детектора ботов готов",
        user_id=user.id,
        visits=int(totals["total_visits"]),
        suspicious=int(totals["suspicious_visits"]),
        wasted=totals["wasted_rub"],
    )

    return {
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else datetime.now(timezone.utc).isoformat(),
        "period_from": date_from,
        "period_to": date_to,
        "report": payload,
        "advice": advice.to_dict(),
        "message": (
            f"Проверено {int(totals['total_visits'])} визитов: подозрительных — {int(totals['suspicious_visits'])}, "
            f"утечка {_money(totals['wasted_rub'])}, экономия в месяц — {_money(totals['monthly_savings_rub'])}"
        ),
    }


@router.get("/bots", summary="Последний отчёт по ботам")
async def last_bots_report(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Последний сохранённый отчёт: экран BotShield открывается мгновенно."""
    result = await session.execute(
        select(BotReport).where(BotReport.user_id == user.id).order_by(BotReport.created_at.desc()).limit(1),
    )
    row = result.scalar_one_or_none()
    if row is None:
        return {
            "has_report": False,
            "message": "Отчёт ещё не готов — нажмите «Проверить трафик»",
        }

    payload = dict(row.report_data or {})
    totals = _bot_totals(payload)
    return {
        "has_report": True,
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "period_from": row.period_from,
        "period_to": row.period_to,
        "report": payload,
        "totals": totals,
        "summary": row.ai_summary or payload.get("summary") or "",
        "wasted_text": _money(totals["wasted_rub"]),
        "savings_text": _money(totals["monthly_savings_rub"]),
    }


@router.get("/bots/history", summary="История проверок трафика")
async def bots_history(session: DbSession, user: CurrentUser, limit: int = 10) -> dict[str, Any]:
    """История отчётов: видно, помогает ли защита и как меняется риск."""
    result = await session.execute(
        select(BotReport)
        .where(BotReport.user_id == user.id)
        .order_by(BotReport.created_at.desc())
        .limit(min(max(limit, 1), 50)),
    )
    rows = list(result.scalars().all())
    items: list[dict[str, Any]] = []
    for row in rows:
        totals = _bot_totals(row.report_data or {})
        items.append(
            {
                "id": row.id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "period_from": row.period_from,
                "period_to": row.period_to,
                "risk_score": int(totals["risk_score"]),
                "suspicious_visits": int(totals["suspicious_visits"]),
                "wasted_rub": totals["wasted_rub"],
                "wasted_text": _money(totals["wasted_rub"]),
            },
        )

    trend = 0.0
    if len(items) >= 2:
        trend = round(items[0]["risk_score"] - items[1]["risk_score"], 1)

    return {"reports": items, "count": len(items), "risk_trend": trend}


# ──────────────────────────────── Гипотезы ────────────────────────────────


def _card_result(card: Mapping[str, Any], monthly_budget: float) -> dict[str, Any]:
    """Что складываем в JSON гипотезы: карточка движка плюс деньги.

    Хранить эффект в рублях нужно отдельно: процент считается от бюджета,
    который у разных пользователей разный.
    """
    impact_rub = round(monthly_budget * to_float(card.get("expected_impact_pct")) / 100, 2)
    return {
        **dict(card),
        "impact_rub": impact_rub,
        "impact_text": format_money(impact_rub),
    }


def _hypothesis_view(row: Hypothesis) -> dict[str, Any]:
    """Гипотеза в том виде, как её показывает приложение."""
    extra = dict(row.result or {})
    impact_rub = to_float(extra.get("impact_rub"))
    return {
        "id": row.id,
        "code": row.code,
        "title": row.title,
        "description": row.description or "",
        "type": row.type,
        "priority": row.priority,
        "priority_label": "высокий" if row.priority >= PRIORITY_HIGH else "средний" if row.priority >= PRIORITY_MEDIUM else "низкий",
        "status": row.status,
        "expected_impact_pct": round(float(row.expected_impact_pct or 0.0), 1),
        "impact_rub": impact_rub,
        "impact_text": format_money(impact_rub),
        "required_budget": round(float(row.required_budget or 0.0), 2),
        "required_budget_text": format_money(float(row.required_budget or 0.0)),
        "duration_days": row.duration_days,
        "confidence": extra.get("confidence") or "medium",
        "action": extra.get("action") or "",
        "metrics": extra.get("metrics") or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "applied_at": extra.get("applied_at"),
        "comment": extra.get("comment") or "",
    }


def _hypothesis_inputs(
    *,
    totals: Mapping[str, float],
    bot_data: Mapping[str, Any],
    profile: Any,
    keywords: list[dict[str, Any]],
    regions_used: int,
    has_metrika: bool,
    has_goals: bool,
    active_campaigns: int,
    mobile_share_pct: float,
    lost_impression_share: float,
    site: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Собирает входные данные для генератора гипотез из реальных цифр."""
    target_cpa = to_float(profile.target_cpa_rub)
    no_conversion = 0
    expensive = 0
    for row in keywords:
        clicks = int(to_float(row.get("clicks")))
        conversions = to_float(row.get("conversions"))
        cost = to_float(row.get("cost_rub"))
        if clicks >= 20 and conversions <= 0:
            no_conversion += 1
        elif conversions > 0 and target_cpa > 0 and cost / conversions > target_cpa * 1.3:
            expensive += 1

    audit = dict(site or {})
    findings = audit.get("findings") or []
    issues = sum(1 for item in findings if str(item.get("severity")) in {"critical", "warning"})

    return {
        "clicks": totals.get("clicks", 0),
        "impressions": totals.get("impressions", 0),
        "cost_rub": totals.get("cost_rub", 0.0),
        "conversions": totals.get("conversions", 0.0),
        "revenue_rub": totals.get("revenue_rub", 0.0),
        "target_cpa_rub": target_cpa,
        "daily_budget_rub": totals.get("daily_budget_rub", 0.0),
        "bot_share_pct": to_float(bot_data.get("suspicious_share_pct")),
        "bot_wasted_rub": to_float(bot_data.get("wasted_rub")),
        "site_score": int(to_float(audit.get("score"))) if audit else 100,
        "site_issues": issues,
        "lost_impression_share": lost_impression_share,
        "active_campaigns": active_campaigns,
        "regions_used": regions_used,
        "has_retargeting": False,
        "has_metrika": has_metrika,
        "has_goals": has_goals,
        "no_conversion_keywords": no_conversion,
        "expensive_keywords": expensive,
        "avg_position": 0.0,
        "mobile_share_pct": mobile_share_pct,
    }


@router.post("/hypotheses", summary="Собрать гипотезы роста")
async def build_hypotheses(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    site_url: SiteUrlDep,
    metrika: OptionalMetrikaClientDep,
    direct: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Считает гипотезы по всем данным и сохраняет новые в базу.

    Повторный запуск не дублирует карточки: гипотеза с тем же кодом обновляет
    цифры, а решение пользователя (принята или отклонена) сохраняется.
    """
    date_from, date_to = _period()

    campaign_stats: list[dict[str, Any]] = []
    keywords: list[dict[str, Any]] = []
    daily_budget = 0.0
    active_campaigns = 0
    if direct is not None:
        campaign_stats = await _safe_call(
            direct.campaign_statistics(date_from=date_from, date_to=date_to),
            default=[],
            label="статистика кампаний",
        )
        keywords = await _safe_call(
            direct.keyword_statistics(
                date_from=date_from,
                date_to=date_to,
                target_cpa_rub=to_float(profile.target_cpa_rub),
            ),
            default=[],
            label="статистика по фразам",
        )
        campaigns = await _safe_call(direct.get_campaigns(), default=[], label="список кампаний")
        for row in campaigns:
            state = str(row.get("State") or "").upper()
            if state in {"ON", "STARTED"}:
                active_campaigns += 1
            daily_budget += to_float(row.get("DailyBudget")) / 1_000_000
        daily_budget = round(daily_budget, 2)

    totals = {
        "clicks": sum(int(to_float(row.get("clicks"))) for row in campaign_stats),
        "impressions": sum(int(to_float(row.get("impressions"))) for row in campaign_stats),
        "cost_rub": round(sum(to_float(row.get("cost_rub")) for row in campaign_stats), 2),
        "conversions": round(sum(to_float(row.get("conversions")) for row in campaign_stats), 2),
        "revenue_rub": 0.0,
        "daily_budget_rub": daily_budget,
    }

    share_points = [
        to_float(row.get("impression_share")) for row in campaign_stats if row.get("impression_share") is not None
    ]
    lost_impression_share = round(max(0.0, (1 - sum(share_points) / len(share_points)) * 100), 1) if share_points else 0.0

    # Боты: считаем на визитах, если Метрика подключена
    bot_data: dict[str, Any] = {}
    visits: list[dict[str, Any]] = []
    if metrika is not None:
        visits = await _safe_call(
            metrika.visits(date_from=date_from, date_to=date_to),
            default=[],
            label="визиты для гипотез",
        )
        if visits and campaign_stats:
            visits = attach_visit_costs(visits, campaign_stats)
        bot_data = bot_detector.detect_bots(
            visits or [],
            days=REPORT_PERIOD_DAYS,
            conversion_price_rub=to_float(profile.target_cpa_rub),
        ).to_dict()

    # Мобильная доля и цели — из Метрики, если она доступна
    mobile_share_pct = 0.0
    has_goals = False
    if metrika is not None:
        devices = await _safe_call(metrika.by_device(days=REPORT_PERIOD_DAYS), default=[], label="устройства")
        total_visits = sum(to_float(row.get("visits")) for row in devices) or 0.0
        mobile_visits = sum(
            to_float(row.get("visits"))
            for row in devices
            if str(row.get("device") or row.get("name") or "").lower().startswith(("smart", "mobile", "телефон"))
            or str(row.get("device") or "").upper() in {"SMARTPHONES", "PHONES", "TABLETS"}
        )
        mobile_share_pct = round(mobile_visits / total_visits * 100, 1) if total_visits else 0.0
        goals = await _safe_call(metrika.list_goals(), default=[], label="цели Метрики")
        has_goals = bool(goals)

    # Аудит сайта: не критичен для гипотез, но усиливает выводы
    site_audit: dict[str, Any] | None = None
    if site_url:
        fetched = await _safe_call(fetch_page(site_url), default=None, label="проверка сайта для гипотез")
        if fetched is not None:
            page, _response = fetched
            site_audit = seo_analyzer.analyze_page(page).to_dict()

    inputs = _hypothesis_inputs(
        totals=totals,
        bot_data=bot_data,
        profile=profile,
        keywords=keywords,
        regions_used=len({int(to_float(item.get("region_code"))) for item in visits if item.get("region_code")}),
        has_metrika=metrika is not None,
        has_goals=has_goals,
        active_campaigns=active_campaigns,
        mobile_share_pct=mobile_share_pct,
        lost_impression_share=lost_impression_share,
        site=site_audit,
    )

    proposal = hypothesis_engine.generate_hypotheses(inputs, limit=12, min_impressions=MIN_IMPRESSIONS_FOR_HYPOTHESES)
    monthly_budget = to_float(profile.monthly_budget_rub) or round(to_float(totals["cost_rub"]) * 30 / REPORT_PERIOD_DAYS, 2)

    existing_result = await session.execute(select(Hypothesis).where(Hypothesis.user_id == user.id))
    existing = {row.code: row for row in existing_result.scalars().all()}

    created = 0
    updated = 0
    for card in proposal.cards:
        payload = _card_result(card.to_dict(), monthly_budget)
        row = existing.get(card.code)
        if row is None:
            session.add(
                Hypothesis(
                    user_id=user.id,
                    code=card.code,
                    type=card.type,
                    title=card.title,
                    description=card.description,
                    expected_impact_pct=round(float(card.expected_impact_pct), 1),
                    required_budget=round(float(card.required_budget), 2),
                    duration_days=int(card.duration_days),
                    priority=int(card.priority),
                    status="pending",
                    result=payload,
                ),
            )
            created += 1
        else:
            # Решение пользователя не трогаем: важны только свежие цифры
            row.type = card.type
            row.title = card.title
            row.description = card.description
            row.expected_impact_pct = round(float(card.expected_impact_pct), 1)
            row.required_budget = round(float(card.required_budget), 2)
            row.duration_days = int(card.duration_days)
            row.priority = int(card.priority)
            row.result = {**dict(row.result or {}), **payload}
            updated += 1

    await session.commit()
    log.info("Гипотезы собраны", user_id=user.id, created=created, updated=updated, cards=len(proposal.cards))

    pending_result = await session.execute(
        select(Hypothesis)
        .where(Hypothesis.user_id == user.id, Hypothesis.status == "pending")
        .order_by(Hypothesis.priority.desc()),
    )
    pending = list(pending_result.scalars().all())
    total_impact = sum(to_float((row.result or {}).get("impact_rub")) for row in pending)

    return {
        "ok": True,
        "created": created,
        "updated": updated,
        "hypotheses": [_hypothesis_view(row) for row in pending],
        "count": len(pending),
        "total_impact_rub": round(total_impact, 2),
        "total_impact_text": format_money(total_impact),
        "notes": list(proposal.notes),
        "inputs": inputs,
        "message": f"Готово: новых гипотез — {created}, обновлено — {updated}",
    }


@router.get("/hypotheses", summary="Список гипотез")
async def list_hypotheses(session: DbSession, user: CurrentUser, status_filter: str = "") -> dict[str, Any]:
    """Гипотезы по убыванию приоритета — карточки для экрана."""
    query = select(Hypothesis).where(Hypothesis.user_id == user.id)
    if status_filter in {"pending", "applied", "rejected"}:
        query = query.where(Hypothesis.status == status_filter)
    result = await session.execute(
        query.order_by(Hypothesis.priority.desc(), Hypothesis.created_at.desc()).limit(100),
    )
    rows = list(result.scalars().all())

    groups: dict[str, list[dict[str, Any]]] = {"high": [], "medium": [], "low": []}
    for row in rows:
        view = _hypothesis_view(row)
        if row.priority >= PRIORITY_HIGH:
            bucket = "high"
        elif row.priority >= PRIORITY_MEDIUM:
            bucket = "medium"
        else:
            bucket = "low"
        view["bucket"] = bucket
        groups[bucket].append(view)

    pending = [row for row in rows if row.status == "pending"]
    pending_impact = sum(to_float((row.result or {}).get("impact_rub")) for row in pending)

    return {
        "hypotheses": [_hypothesis_view(row) for row in rows],
        "groups": groups,
        "count": len(rows),
        "pending_count": len(pending),
        "total_impact_rub": round(pending_impact, 2),
        "total_impact_text": format_money(pending_impact),
        "impact_by_bucket": {
            key: format_money(sum(to_float(item["impact_rub"]) for item in items)) for key, items in groups.items()
        },
    }


class HypothesisDecision(BaseModel):
    """Решение по гипотезе: запустить, отклонить или отложить."""

    action: str = Field(description="apply | reject | later")
    comment: str = Field(default="", description="Комментарий владельца")


@router.post("/hypotheses/{hypothesis_id}", summary="Запустить или отклонить гипотезу")
async def decide_hypothesis(
    hypothesis_id: int,
    payload: HypothesisDecision,
    session: DbSession,
    user: CurrentUser,
) -> dict[str, Any]:
    """Фиксирует решение по карточке: «Запустить», «Отклонить» или «Позже».

    Принятая гипотеза получает статус applied — бот применит конкретные
    изменения в Директе и покажет результат в отчёте.
    """
    result = await session.execute(
        select(Hypothesis).where(Hypothesis.id == hypothesis_id, Hypothesis.user_id == user.id),
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Гипотеза не найдена")

    mapping = {"apply": "applied", "reject": "rejected", "later": "pending"}
    if payload.action not in mapping:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Действие должно быть apply, reject или later",
        )

    extra = dict(row.result or {})
    row.status = mapping[payload.action]
    if payload.action == "apply":
        extra["applied_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if payload.comment:
        extra["comment"] = payload.comment.strip()[:500]
    row.result = extra
    await session.commit()

    log.info("Решение по гипотезе", user_id=user.id, hypothesis=row.code, action=payload.action)
    titles = {"apply": "Гипотеза принята в работу", "reject": "Гипотеза отклонена", "later": "Гипотеза отложена"}
    return {"ok": True, "message": titles[payload.action], "hypothesis": _hypothesis_view(row)}


@router.get("/hypotheses/{hypothesis_id}/explain", summary="Объяснить гипотезу словами")
async def explain(hypothesis_id: int, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Текст от AI-советника: что это даст и что сделать — простыми словами."""
    result = await session.execute(
        select(Hypothesis).where(Hypothesis.id == hypothesis_id, Hypothesis.user_id == user.id),
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Гипотеза не найдена")

    view = _hypothesis_view(row)
    advice = await explain_hypothesis(
        {
            "title": view["title"],
            "description": view["description"],
            "action": view["action"],
            "impact_pct": view["expected_impact_pct"],
            "expected_effect_rub": view["impact_rub"],
            "priority": view["priority"],
            "type": view["type"],
        },
        client=None,
    )
    return {"hypothesis": view, "advice": advice.to_dict()}


# ──────────────────────────────── Аудит сайта ────────────────────────────────


@router.post("/site", summary="Проверить сайт клиента")
async def site_report(session: DbSession, user: CurrentUser, site_url: SiteUrlDep) -> dict[str, Any]:
    """Технический аудит сайта: скорость, мобильная версия, SEO, цели.

    Работает с любой платформой — Tilda, WordPress, Vercel, самописный сайт:
    мы читаем страницу и смотрим, что мешает получать заявки.
    """
    if not site_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Укажите адрес сайта в настройках — тогда проверю скорость, мобильную версию и SEO",
        )

    try:
        page, response = await fetch_page(site_url)
    except SiteError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error

    audit = seo_analyzer.analyze_page(page)
    payload = audit.to_dict()
    payload["url"] = page.url
    payload["status_code"] = page.status_code
    payload["response_ms"] = page.response_ms
    payload["platform"] = detect_platform(page.html, page.headers)[1] if page.html else ""
    payload["quick_fixes"] = seo_analyzer.quick_fixes(audit.findings)

    passport = None
    try:
        passport = (await build_passport(site_url)).to_dict()
    except Exception as error:  # noqa: BLE001 — паспорт не критичен для аудита
        log.warning("Паспорт сайта не собрался в аудите", url=site_url, reason=str(error)[:120])

    advice = await summarize_site_audit(payload, client=None)
    payload["summary"] = advice.text
    payload["summary_source"] = advice.source

    critical = sum(1 for item in payload.get("findings", []) if str(item.get("severity")) == "critical")
    log.info("Аудит сайта готов", user_id=user.id, score=payload.get("score"), critical=critical)

    return {
        "audit": payload,
        "passport": passport,
        "advice": advice.to_dict(),
        "message": f"Оценка сайта: {payload.get('score', 0)}/100, критичных проблем — {critical}",
    }


# ─────────────────────────────── География ───────────────────────────────


async def _geo_payload(
    profile: Any,
    metrika: Any,
    direct: Any,
) -> tuple[dict[str, Any], Any]:
    """Считает геоанализ: общий код для «посчитать» и «показать»."""
    target_cpa = to_float(profile.target_cpa_rub)
    if target_cpa <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Укажите целевую цену заявки в настройках — без неё сравнивать города не с чем",
        )

    date_from, date_to = _period()
    visits = await _gather_visits(
        metrika,
        direct,
        date_from=date_from,
        date_to=date_to,
        reason="Для геоанализа нужна Метрика — подключите счётчик",
    )
    regions = _regions_from_visits(visits)
    if not regions:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="В выгрузке Метрики нет городов — проверьте, что счётчик собирает данные за последние 30 дней",
        )

    plan = geo_analyzer.analyze_geo(
        regions,
        target_cpa_rub=target_cpa,
        total_budget_rub=round(to_float(profile.monthly_budget_rub) / REPORT_PERIOD_DAYS, 2),
    )
    payload = plan.to_dict()
    payload["period_from"] = date_from
    payload["period_to"] = date_to
    payload["regions"] = [
        {
            "code": item["region_code"],
            "name": geo_analyzer.region_name(item["region_code"]),
            "clicks": item["clicks"],
            "cost_rub": round(item["cost_rub"], 2),
            "conversions": round(item["conversions"], 2),
            "cpa_rub": round(item["cost_rub"] / item["conversions"], 2) if item["conversions"] else 0.0,
        }
        for item in regions[:20]
    ]
    payload["total_cost_rub"] = round(sum(item["cost_rub"] for item in regions), 2)
    payload["total_conversions"] = round(sum(item["conversions"] for item in regions), 2)
    return payload, plan


@router.post("/geo", summary="Где реклама работает, а где сжигает бюджет")
async def geo_report(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    metrika: OptionalMetrikaClientDep,
    direct: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Сравнивает города по цене заявки и предлагает, где снизить ставки."""
    payload, plan = await _geo_payload(profile, metrika, direct)

    advice = await summarize_geo(payload, client=None)
    payload["summary_text"] = advice.text
    payload["summary_source"] = advice.source

    best = plan.summary.get("best_region") if isinstance(plan.summary, dict) else None
    await session.commit()
    log.info("Геоотчёт готов", user_id=user.id, regions=len(payload.get("advices") or []))

    message = f"Разобрано регионов: {len(payload.get('advices') or [])}"
    if best:
        message += f", лучший — {best.get('name', '—')}"
    savings = to_float((plan.summary or {}).get("potential_savings_rub"))
    if savings:
        message += f", экономия до {_money(savings)}"

    return {"analysis": payload, "advice": advice.to_dict(), "message": message}


@router.get("/geo", summary="Геоотчёт для экрана")
async def last_geo_report(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    metrika: OptionalMetrikaClientDep,
    direct: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Тот же расчёт в режиме чтения — экран открывается без кнопки."""
    return await geo_report(session, user, profile, metrika, direct)


# ──────────────────────────────── Рынок ────────────────────────────────


@router.post("/market", summary="Ориентиры по нише и конкуренты")
async def market_report(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    direct: OptionalDirectClientDep,
) -> dict[str, Any]:
    """Что происходит на рынке: цена клика, конкуренция, план бюджета."""
    if not profile.niche:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Выберите нишу в настройках — тогда покажу ориентиры по рынку",
        )

    your_clicks = 0
    your_cost = 0.0
    your_conversions = 0.0
    if direct is not None:
        date_from, date_to = _period()
        rows = await _safe_call(
            direct.campaign_statistics(date_from=date_from, date_to=date_to),
            default=[],
            label="статистика для рынка",
        )
        your_clicks = sum(int(to_float(row.get("clicks"))) for row in rows)
        your_cost = round(sum(to_float(row.get("cost_rub")) for row in rows), 2)
        your_conversions = round(sum(to_float(row.get("conversions")) for row in rows), 2)

    try:
        analysis = market_analyzer.analyze_market(
            niche=profile.niche,
            region_code=profile.region_code,
            region_name=profile.region_name or None,
            monthly_budget_rub=to_float(profile.monthly_budget_rub),
            your_clicks=your_clicks,
            your_cost_rub=your_cost,
            your_conversions=your_conversions,
            target_cpa_rub=to_float(profile.target_cpa_rub),
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    payload = analysis.to_dict()
    advice = await market_advice(payload, client=None)
    payload["summary_text"] = advice.text
    payload["summary_source"] = advice.source

    await session.commit()
    market_cpc = to_float(payload.get("market_cpc_rub"))
    return {
        "analysis": payload,
        "niches": market_analyzer.niches_catalog(),
        "advice": advice.to_dict(),
        "message": (
            f"{payload.get('niche_name', 'Ниша')}: клик около {_money(market_cpc)}, "
            f"конкуренция — {payload.get('competition', 'средняя')}"
        ),
    }


# ──────────────────────────── Общая картина ────────────────────────────


@router.get("/overview", summary="Что уже посчитано")
async def overview(
    session: DbSession,
    user: CurrentUser,
    profile: ProfileDep,
    site_url: SiteUrlDep,
) -> dict[str, Any]:
    """Список отчётов с их состоянием — для экрана «Отчёты»."""
    bot_result = await session.execute(
        select(BotReport).where(BotReport.user_id == user.id).order_by(BotReport.created_at.desc()).limit(1),
    )
    last_bot = bot_result.scalar_one_or_none()

    hypothesis_result = await session.execute(
        select(Hypothesis).where(Hypothesis.user_id == user.id, Hypothesis.status == "pending"),
    )
    pending = list(hypothesis_result.scalars().all())
    pending_impact = sum(to_float((row.result or {}).get("impact_rub")) for row in pending)

    bot_totals = _bot_totals(last_bot.report_data or {}) if last_bot is not None else {}

    return {
        "reports": [
            {
                "key": "bots",
                "title": "Защита от ботов",
                "ready": last_bot is not None,
                "created_at": last_bot.created_at.isoformat() if last_bot is not None and last_bot.created_at else None,
                "highlight": _money(bot_totals.get("wasted_rub", 0.0)) if last_bot is not None else "",
                "hint": "Найдите накрутку и верните деньги в рекламу",
            },
            {
                "key": "hypotheses",
                "title": "Гипотезы роста",
                "ready": bool(pending),
                "created_at": None,
                "highlight": format_money(pending_impact),
                "hint": f"Ожидают решения: {len(pending)}",
            },
            {
                "key": "site",
                "title": "Аудит сайта",
                "ready": bool(site_url),
                "created_at": None,
                "highlight": "—",
                "hint": "Скорость, мобильная версия и SEO",
            },
            {
                "key": "geo",
                "title": "География рекламы",
                "ready": False,
                "created_at": None,
                "highlight": "—",
                "hint": "Какие города приносят заявки, а какие жгут бюджет",
            },
            {
                "key": "market",
                "title": "Рынок и конкуренты",
                "ready": bool(profile.niche),
                "created_at": None,
                "highlight": profile.niche_title or profile.niche or "—",
                "hint": "Ориентиры по цене клика в вашей нише",
            },
        ],
        "profile": profile.to_dict(),
        "site_url": site_url or "",
    }


__all__ = ["router"]
