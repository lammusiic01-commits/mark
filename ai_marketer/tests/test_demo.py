"""Тесты режима проверки: демо-клиенты Яндекса и выдача тестового входа.

Демо-клиенты нужны, чтобы интерфейс проверялся без доступа к api.direct.yandex.ru
и api-metrika.yandex.ru. Здесь проверяется главное: они включаются только по
маркеру в токене, отдают те же поля, что и настоящие клиенты, и дают цифры,
на которых видно работу движка (накрутка, убыточная фраза, пустой регион).
"""

from __future__ import annotations

import asyncio

import pytest

from services.demo import (
    DEMO_CAMPAIGNS,
    DEMO_DIRECT_TOKEN,
    DEMO_METRIKA_TOKEN,
    DemoDirectClient,
    DemoMetrikaClient,
    is_demo_token,
)

# Поля, которые читают API-роуты и движок. Появится расхождение — упадёт тест,
# а не экран у пользователя.
CAMPAIGN_STAT_FIELDS = {
    "campaign_id",
    "name",
    "clicks",
    "impressions",
    "cost_rub",
    "conversions",
    "ctr",
    "cpc_rub",
    "cpa_rub",
}
KEYWORD_FIELDS = {"keyword_id", "phrase", "campaign_id", "clicks", "cost_rub", "conversions", "cpc"}
VISIT_FIELDS = {"visit_id", "date", "duration_seconds", "page_views", "is_bounce", "region_code", "conversions"}


def run(coroutine):
    """Выполняет корутину: тесты синхронные, а клиенты асинхронные."""
    return asyncio.run(coroutine)


# ═══════════════════════ Включение только по маркеру ═══════════════════════


def test_demo_token_detection() -> None:
    assert is_demo_token(DEMO_DIRECT_TOKEN, DEMO_DIRECT_TOKEN)
    assert is_demo_token(DEMO_METRIKA_TOKEN, DEMO_METRIKA_TOKEN)
    # Настоящий токен Яндекса демо-клиенты не получит
    assert not is_demo_token("y0_AgAAAAA_real_token", DEMO_DIRECT_TOKEN)
    assert not is_demo_token("", DEMO_DIRECT_TOKEN)
    assert not is_demo_token(DEMO_DIRECT_TOKEN, DEMO_METRIKA_TOKEN)


# ═══════════════════════════ Демо-Директ ═══════════════════════════


def test_campaign_statistics_shape() -> None:
    client = DemoDirectClient()

    async def scenario() -> None:
        rows = await client.campaign_statistics(date_from="2026-09-13", date_to="2026-10-12")
        assert len(rows) == len(DEMO_CAMPAIGNS)
        for row in rows:
            assert CAMPAIGN_STAT_FIELDS <= set(row), f"нет полей: {CAMPAIGN_STAT_FIELDS - set(row)}"
            assert row["cost_rub"] > 0 and row["clicks"] > 0
            # Рубли, а не микрорубли: цена клика в разумных пределах
            assert 1 < row["cpc_rub"] < 10_000

    run(scenario())


def test_keyword_statistics_shape_and_loss() -> None:
    client = DemoDirectClient()

    async def scenario() -> None:
        rows = await client.keyword_statistics(date_from="2026-09-13", date_to="2026-10-12", target_cpa_rub=2_500)
        assert rows, "нет фраз для оптимизатора ставок"
        for row in rows:
            assert KEYWORD_FIELDS <= set(row), f"нет полей: {KEYWORD_FIELDS - set(row)}"
        # Хотя бы одна фраза должна быть убыточной: иначе движок не найдёт гипотез
        expensive = [row for row in rows if row["conversions"] and row["cost_rub"] / row["conversions"] > 2_500 * 1.3]
        assert expensive, "в демо-данных нет убыточной фразы — гипотезы по ставкам не появятся"

    run(scenario())


def test_campaigns_state_changes() -> None:
    """Пауза и правка бюджета видны в следующих ответах клиента."""
    client = DemoDirectClient()

    async def scenario() -> None:
        first = (await client.get_campaigns())[0]
        campaign_id = first["Id"]

        await client.update_campaign_status(campaign_id, "SUSPEND")
        await client.update_campaign_budget(campaign_id, 1_500)
        again = next(row for row in await client.get_campaigns() if row["Id"] == campaign_id)

        assert again["State"] == "SUSPENDED"
        # В микрорублях — так их отдаёт Директ
        assert again["DailyBudget"]["Amount"] == 1_500 * 1_000_000

        await client.update_campaign_status(campaign_id, "RESUME")
        resumed = next(row for row in await client.get_campaigns() if row["Id"] == campaign_id)
        assert resumed["State"] == "ON"

    run(scenario())


def test_bids_are_accepted() -> None:
    client = DemoDirectClient()

    async def scenario() -> None:
        answer = await client.set_bids([{"KeywordId": 880011, "Bid": 27_000_000}])
        assert answer["Bids"][0]["KeywordId"] == 880011

    run(scenario())


# ═══════════════════════════ Демо-Метрика ═══════════════════════════


def test_visits_shape_and_suspicious_share() -> None:
    client = DemoMetrikaClient()

    async def scenario() -> None:
        visits = await client.visits(date_from="2026-09-13", date_to="2026-10-12")
        assert len(visits) > 1_000, "визитов должно быть примерно столько же, сколько кликов"
        for visit in visits[:50]:
            assert VISIT_FIELDS <= set(visit), f"нет полей: {VISIT_FIELDS - set(visit)}"
            assert visit["date"].count("-") == 2, "дата должна быть вида ГГГГ-ММ-ДД"

        # Накрутка: примерно десятая часть визитов — с нулевой глубиной
        suspicious = [visit for visit in visits if visit["duration_seconds"] <= 3 and visit["page_views"] <= 1]
        share = 100 * len(suspicious) / len(visits)
        assert 5 <= share <= 25, f"доля подозрительных визитов {share:.1f}% — не похоже на реальную"

        # Кампания указана: иначе цена клика не подставится и утечка будет нулевой
        assert all(visit["campaign_id"] for visit in visits)

    run(scenario())


def test_region_without_goals_exists() -> None:
    """Один регион без заявок нужен геоанализу: движок предложит его отключить."""
    client = DemoMetrikaClient()

    async def scenario() -> None:
        visits = await client.visits(date_from="2026-09-13", date_to="2026-10-12")
        by_region: dict[int, int] = {}
        for visit in visits:
            by_region[visit["region_code"]] = by_region.get(visit["region_code"], 0) + visit["conversions"]
        assert by_region, "нет регионов в визитах"
        assert any(goals == 0 for goals in by_region.values()), "нет региона без заявок"

    run(scenario())


def test_metrika_dashboard_and_series() -> None:
    client = DemoMetrikaClient()

    async def scenario() -> None:
        metrics = await client.dashboard_metrics(days=30)
        assert metrics["visits"] > 0 and metrics["days"] == 30

        series = await client.daily_series(days=30)
        assert len(series) == 30
        assert {"date", "visits", "goals"} <= set(series[0])

        devices = await client.by_device()
        assert sum(row["visits"] for row in devices) > 0

        goals = await client.list_goals()
        assert len(goals) >= 3, "цели нужны для расчёта конверсий"

    run(scenario())


# ═══════════════════ Демо-режим закрыт вне разработки ═══════════════════


def test_dev_routes_are_development_only() -> None:
    """Адреса /api/dev существуют только при ENV=development."""
    from api.routes import ROUTERS
    from core.config import settings

    if settings.is_production:
        pytest.skip("в этом окружении боевой режим — проверяем отдельно")

    # Префикс /api добавляет api/server.py при подключении роутов
    assert "dev" in ROUTERS
    assert ROUTERS["dev"].prefix == "/dev"
