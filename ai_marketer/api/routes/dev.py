"""Режим разработки: вход без Telegram и демо-данные для проверки в браузере.

Зачем это нужно: Mini App открывается внутри Telegram, и проверить вёрстку на
компьютере иначе нельзя. В режиме разработки (ENV=development) приложение
может попросить подписанную строку initData и наполнить базу примером данных —
тогда все экраны видно в обычном браузере.

Безопасность:
  • в боевом режиме (ENV=production) роут не подключается вовсе;
  • дополнительно каждый запрос проверяет режим и получает 404;
  • подпись выдаётся тем же алгоритмом, что и у Telegram, — приложение
    работает по обычному пути авторизации, без «дырок» в проверках.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select

from api.auth import sign_init_data
from core.config import settings
from core.database import create_all
from core.logger import get_logger
from core.models import BotReport, Campaign, Payment, ServiceConnection, User, get_or_create_user
from core.security import mask_secret

log = get_logger(__name__)

router = APIRouter(prefix="/dev", tags=["режим разработки"])


def _ensure_dev() -> None:
    """Пускает только в режиме разработки."""
    if settings.is_production:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")


@router.get("/sign-in", summary="Вход без Telegram (только для разработки)")
async def dev_sign_in(
    tg_id: int = Query(default=1, description="Telegram ID для проверки"),
    first_name: str = Query(default="Игорь", description="Имя пользователя"),
    username: str = Query(default="dev_user", description="Username"),
) -> dict[str, Any]:
    """Отдаёт подписанный initData: приложение сохраняет его и работает как обычно."""
    _ensure_dev()

    init_data = sign_init_data(
        {
            "id": tg_id,
            "first_name": first_name,
            "username": username,
            "language_code": "ru",
            "is_premium": True,
        },
        settings.BOT_TOKEN,
    )
    log.warning("Выдан тестовый вход в приложение (режим разработки)", tg_id=tg_id)
    return {
        "init_data": init_data,
        "user": {"id": tg_id, "first_name": first_name, "username": username},
        "hint": "Сохраните init_data и передавайте его в заголовке X-Telegram-Init-Data",
    }


@router.post("/seed", summary="Демо-данные для проверки экранов")
async def dev_seed(tg_id: int = Query(default=1, description="Telegram ID пользователя")) -> dict[str, Any]:
    """Наполняет базу примером: кампании, статистика, отчёт по ботам, баланс.

    Данные правдоподобные (ремонт квартир в Москве), чтобы на экранах были
    осмысленные суммы, а не нули. Повторный вызов обновляет те же записи.
    """
    _ensure_dev()
    await create_all()

    from core.database import session_scope

    async with session_scope() as session:
        user, created = await get_or_create_user(
            session,
            tg_id,
            username="dev_user",
            first_name="Игорь",
            last_name="Разработчик",
            language_code="ru",
        )
        user.onboarding_completed = True
        user.balance = 25_000.0

        # Профиль бизнеса
        profile_row = (
            await session.execute(
                select(ServiceConnection).where(
                    ServiceConnection.user_id == user.id,
                    ServiceConnection.service_type == "profile",
                ),
            )
        ).scalar_one_or_none()
        profile_meta = {
            "niche": "стройка-ремонт",
            "niche_title": "Стройка и ремонт",
            "region_code": 213,
            "region_name": "Москва",
            "monthly_budget_rub": 150_000.0,
            "target_cpa_rub": 2_500.0,
            "site_url": "https://remont-demo.ru",
            "updated_from": "dev",
        }
        if profile_row is None:
            session.add(
                ServiceConnection(
                    user_id=user.id,
                    service_type="profile",
                    encrypted_token="",
                    metadata_json=profile_meta,
                    is_active=True,
                ),
            )
        else:
            profile_row.metadata_json = profile_meta
            profile_row.is_active = True

        # Подключения сервисов: без токенов, только для вида экранов
        connections = [
            ("yandex_direct", {"login": "remont-demo", "campaigns": 3, "currency": "RUB", "token_masked": mask_secret("y0_AgDEMO")}),
            ("yandex_metrika", {"counter_id": 98765432, "counter_name": "Сайт ремонта", "goals": 3, "token_masked": mask_secret("y0_AgMETRIKA")}),
            ("hosting", {"site_url": "https://remont-demo.ru", "platform": "Tilda", "platform_title": "Tilda Publishing", "hosting": "Cloudflare", "https": True, "has_metrika": True}),
        ]
        for service_type, meta in connections:
            row = (
                await session.execute(
                    select(ServiceConnection).where(
                        ServiceConnection.user_id == user.id,
                        ServiceConnection.service_type == service_type,
                    ),
                )
            ).scalar_one_or_none()
            if row is None:
                session.add(
                    ServiceConnection(
                        user_id=user.id,
                        service_type=service_type,
                        encrypted_token="",  # демо-подключение: токен не нужен
                        metadata_json=meta,
                        is_active=True,
                        last_checked_at=datetime.now(timezone.utc),
                    ),
                )
            else:
                row.metadata_json = meta
                row.is_active = True

        # Кампании со статистикой за 30 дней
        demo_campaigns = [
            {
                "external_id": "7100111",
                "name": "Ремонт квартир — поиск, Москва",
                "status": "active",
                "daily_budget": 4_000.0,
                "clicks": 1_180,
                "impressions": 26_400,
                "cost_rub": 84_960.0,
                "conversions": 34.0,
            },
            {
                "external_id": "7100222",
                "name": "Ремонт под ключ — РСЯ",
                "status": "active",
                "daily_budget": 1_800.0,
                "clicks": 940,
                "impressions": 61_200,
                "cost_rub": 23_500.0,
                "conversions": 9.0,
            },
            {
                "external_id": "7100333",
                "name": "Дизайн-проект — ретаргетинг",
                "status": "paused",
                "daily_budget": 1_200.0,
                "clicks": 260,
                "impressions": 8_100,
                "cost_rub": 9_100.0,
                "conversions": 1.0,
            },
        ]
        period_from = (date.today() - timedelta(days=29)).isoformat()
        for item in demo_campaigns:
            row = (
                await session.execute(
                    select(Campaign).where(
                        Campaign.user_id == user.id,
                        Campaign.external_id == item["external_id"],
                    ),
                )
            ).scalar_one_or_none()
            stats = {
                "period_days": 30,
                "clicks": item["clicks"],
                "impressions": item["impressions"],
                "cost_rub": item["cost_rub"],
                "conversions": item["conversions"],
                "cpa_rub": round(item["cost_rub"] / item["conversions"], 2) if item["conversions"] else 0.0,
                "ctr": round(item["clicks"] / item["impressions"] * 100, 2) if item["impressions"] else 0.0,
                "cpc_rub": round(item["cost_rub"] / item["clicks"], 2) if item["clicks"] else 0.0,
                "updated_at": date.today().isoformat(),
            }
            if row is None:
                session.add(
                    Campaign(
                        user_id=user.id,
                        external_id=item["external_id"],
                        name=item["name"],
                        status=item["status"],
                        daily_budget=item["daily_budget"],
                        target_cpa=2_500.0,
                        stats_cache=stats,
                        stats_updated_at=datetime.now(timezone.utc),
                    ),
                )
            else:
                row.name = item["name"]
                row.status = item["status"]
                row.daily_budget = item["daily_budget"]
                row.stats_cache = stats
                row.stats_updated_at = datetime.now(timezone.utc)

        # Отчёт детектора ботов
        report_payload = _demo_bot_report()
        bot_row = (
            await session.execute(
                select(BotReport).where(BotReport.user_id == user.id).order_by(BotReport.created_at.desc()).limit(1),
            )
        ).scalar_one_or_none()
        if bot_row is None:
            session.add(
                BotReport(
                    user_id=user.id,
                    period_from=period_from,
                    period_to=date.today().isoformat(),
                    report_data=report_payload,
                    ai_summary=report_payload["summary"],
                ),
            )
        else:
            bot_row.report_data = report_payload
            bot_row.ai_summary = report_payload["summary"]

        # История платежей: чтобы журнал операций был не пустым
        result = await session.execute(
            select(func.count()).select_from(Payment).where(Payment.user_id == user.id),
        )
        payments_count = result.scalar_one()
        if not payments_count:
            session.add(
                Payment(
                    user_id=user.id,
                    payment_id="SBP-DEMO-0001",
                    amount=25_000.0,
                    status="paid",
                    sbp_url="",
                    qr_payload="Демо-пополнение",
                    paid_at=datetime.now(timezone.utc) - timedelta(days=2),
                ),
            )

    log.warning("Загружены демо-данные (режим разработки)", tg_id=tg_id, created=created)
    return {
        "ok": True,
        "tg_id": tg_id,
        "campaigns": len(demo_campaigns),
        "balance": 25_000.0,
        "message": "Демо-данные готовы: кампании, отчёт по ботам, баланс и журнал операций",
    }


def _demo_bot_report() -> dict[str, Any]:
    """Правдоподобный отчёт детектора ботов: те же поля, что считает движок."""
    days: list[dict[str, Any]] = []
    for index in range(30):
        day = (date.today() - timedelta(days=29 - index)).isoformat()
        wave = 18 if index % 7 in (2, 3) else 4
        days.append(
            {
                "date": day,
                "visits": 70 + wave * 3,
                "suspicious": wave,
                "cost_rub": round((70 + wave * 3) * 58.4, 2),
                "wasted_rub": round(wave * 58.4, 2),
            },
        )

    wasted = round(sum(item["wasted_rub"] for item in days), 2)
    patterns = [
        {
            "code": "instant-bounce",
            "title": "Мгновенные отказы с одного IP",
            "visits": 96,
            "share_pct": 62.3,
            "wasted_rub": round(wasted * 0.62, 2),
            "severity": "critical",
            "reason": "Визиты длятся меньше 3 секунд и идут пачками с одного адреса — так ведёт себя накрутка.",
            "action": "Исключить площадку и включить фильтр ботов в Метрике",
        },
        {
            "code": "ip-cluster",
            "title": "Один IP на десятки визитов",
            "visits": 38,
            "share_pct": 24.7,
            "wasted_rub": round(wasted * 0.25, 2),
            "severity": "warning",
            "reason": "С одного адреса пришло больше 20 визитов за день — живой человек так не ходит.",
            "action": "Добавить IP в исключения кампании",
        },
        {
            "code": "user-agent",
            "title": "Признаки headless-браузера",
            "visits": 20,
            "share_pct": 13.0,
            "wasted_rub": round(wasted * 0.13, 2),
            "severity": "warning",
            "reason": "В user-agent видны признаки автоматизации (HeadlessChrome, PhantomJS).",
            "action": "Включить фильтр по устройствам и проверить источник",
        },
    ]

    return {
        "total_visits": sum(item["visits"] for item in days),
        "suspicious_visits": sum(item["suspicious"] for item in days),
        "suspicious_share_pct": 18.4,
        "wasted_rub": wasted,
        "monthly_savings_rub": round(wasted * 0.86, 2),
        "risk_score": 72,
        "patterns": patterns,
        "daily": days,
        "campaigns_at_risk": [
            {"campaign_id": "7100111", "name": "Ремонт квартир — поиск, Москва", "suspicious": 92, "wasted_rub": round(wasted * 0.65, 2)},
            {"campaign_id": "7100222", "name": "Ремонт под ключ — РСЯ", "suspicious": 62, "wasted_rub": round(wasted * 0.35, 2)},
        ],
        "findings": [
            {
                "code": "bots:instant-bounce",
                "title": "Накрутка кликов в поиске",
                "description": f"Из {sum(item['visits'] for item in days)} визитов подозрительными выглядят {sum(item['suspicious'] for item in days)}.",
                "severity": "critical",
                "impact_rub": wasted,
                "action": "Включить фильтр ботов и исключить площадку",
            },
        ],
        "days": 30,
        "period_from": (date.today() - timedelta(days=29)).isoformat(),
        "period_to": date.today().isoformat(),
        "summary": (
            f"Каждый пятый визит выглядит автоматическим: около {int(wasted)} ₽ за месяц уходит не на клиентов. "
            "Быстрее всего вернуть деньги фильтром ботов в Метрике и исключением площадки, откуда идут пачки отказов."
        ),
        "summary_source": "template",
    }


__all__ = ["router"]
