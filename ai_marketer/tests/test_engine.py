"""Тесты движка: восемь модулей принимают решения, которые видит клиент.

Здесь проверяются именно те цифры и правила, на которых строятся экраны
приложения: боты и утечка в рублях, ставки под целевую цену заявки,
гипотезы роста, проверка сайта, гео-корректировки, рынок, бюджет и кампании.
"""

from __future__ import annotations

import asyncio

import pytest

from engine import bid_optimizer, bot_detector, budget_allocator, campaign_manager, geo_analyzer, hypothesis_engine, market_analyzer, seo_analyzer
from engine.seo_analyzer import PageData


def plain(value: object) -> object:
    """Приводит результат движка к словарю, если это датакласс."""
    return value.to_dict() if hasattr(value, "to_dict") else value


# ──────────────────────────── Детектор ботов ────────────────────────────


def test_bot_detector_finds_bots_and_money() -> None:
    visits = bot_detector.build_demo_visits(days=14, per_day=40)
    report = plain(bot_detector.detect_bots(visits, conversion_price_rub=1500.0))

    assert report["total_visits"] == 560
    assert report["suspicious_visits"] > 0
    assert 0 <= report["risk_score"] <= 100
    assert report["wasted_rub"] > 0, "утечка бюджета должна считаться в рублях"
    assert len(report["patterns"]) >= 2, [pattern["code"] for pattern in report["patterns"]]
    assert report["daily"], "нужен график по дням для экрана BotShield"


def test_bot_detector_clean_traffic() -> None:
    """Живой трафик не должен объявляться ботами."""
    visits = [
        {
            "date": "2026-09-20",
            "visit_id": f"live{index}",
            "duration_seconds": 240 + index,
            "page_views": 5,
            "user_agent": "Mozilla/5.0 (Macintosh) Chrome/121.0.0.0 Safari/537.36",
            "source": "organic",
            "conversions": 1,
            "cost_rub": 0.0,
            "hour": 15,
        }
        for index in range(20)
    ]
    report = plain(bot_detector.detect_bots(visits))
    assert report["suspicious_visits"] == 0
    assert report["risk_score"] < 15


# ──────────────────────────── Ставки ────────────────────────────


def test_bid_optimizer_lowers_overpriced_keywords() -> None:
    stats = [
        {"keyword_id": "1", "phrase": "климат купить", "clicks": 20, "impressions": 500, "cost_rub": 2400.0, "conversions": 2},
        {"keyword_id": "2", "phrase": "климат цена", "clicks": 8, "impressions": 200, "cost_rub": 600.0, "conversions": 0},
        {"keyword_id": "3", "phrase": "климат под ключ", "clicks": 30, "impressions": 900, "cost_rub": 12000.0, "conversions": 3},
    ]
    plan = plain(bid_optimizer.optimize_bids(stats, target_cpa_rub=1000.0))

    assert plan["changes"], "фраза с CPA 4000 ₽ при цели 1000 ₽ должна измениться"
    change = next(item for item in plan["changes"] if item["keyword_id"] == "3")
    assert change["recommended_bid_rub"] < change["current_bid_rub"]
    assert change["reason"], "у изменения должна быть понятная причина"
    assert plan["threshold_rub"] == pytest.approx(1300.0)
    assert plan["summary"]["potential_savings_rub"] > 0
    assert len(plan["findings"]) >= 1


def test_bid_optimizer_keeps_keywords_within_threshold() -> None:
    """Фраза в пределах порога (CPA 1200 ₽ при цели 1000 ₽) не трогается."""
    stats = [{"keyword_id": "1", "phrase": "климат", "clicks": 20, "impressions": 500, "cost_rub": 2400.0, "conversions": 2}]
    plan = plain(bid_optimizer.optimize_bids(stats, target_cpa_rub=1000.0))
    assert plan["changes"] == [], plan["changes"]
    assert plan["summary"]["keywords_in_norm"] == 1


def test_bid_optimizer_grows_cheap_keywords() -> None:
    """Дешёвая заявка — повод поднять ставку и забрать больше трафика."""
    stats = [{"keyword_id": "1", "phrase": "климат", "clicks": 30, "impressions": 900, "cost_rub": 3000.0, "conversions": 6}]
    plan = plain(bid_optimizer.optimize_bids(stats, target_cpa_rub=1000.0))
    assert plan["changes"], "CPA 500 ₽ при цели 1000 ₽ — есть куда расти"
    assert plan["changes"][0]["recommended_bid_rub"] > plan["changes"][0]["current_bid_rub"]
    assert plan["changes"][0]["change_pct"] <= 30.0


# ──────────────────────────── Гипотезы ────────────────────────────


def test_hypothesis_engine_builds_cards() -> None:
    inputs = {
        "keyword_stats": [
            {"keyword_id": "1", "phrase": "климат купить", "clicks": 20, "impressions": 500, "cost_rub": 2400.0, "conversions": 2},
        ],
        "target_cpa_rub": 1000.0,
        "monthly_budget_rub": 26250.0,
        "bot_report": plain(bot_detector.detect_bots(bot_detector.build_demo_visits(days=7, per_day=20))),
    }
    result = plain(hypothesis_engine.generate_hypotheses(inputs))
    assert result["hypotheses"], "гипотезы должны строиться хотя бы по одному фактору"
    for card in result["hypotheses"]:
        assert card["title"]
        assert card["code"]
        assert card["priority"] >= 0
        assert card["type"]


# ──────────────────────────── Сайт ────────────────────────────


def test_seo_analyzer_marks_bad_page() -> None:
    good_result = seo_analyzer.analyze_page(PageData(url="https://site.ru/", html=seo_analyzer.demo_html(), response_ms=400))
    bad_result = seo_analyzer.analyze_page(
        PageData(url="https://site.ru/", html=seo_analyzer.demo_html(bad=True), response_ms=4200),
    )
    good = plain(good_result)
    bad = plain(bad_result)

    assert good["score"] >= 80, good["score"]
    assert bad["score"] < 60, bad["score"]
    assert bad_result.critical_count >= 1, "на плохой странице должны быть критические замечания"
    assert all(finding["code"] for finding in bad["findings"])

    fixes = seo_analyzer.quick_fixes(bad_result.findings)
    assert fixes, "должен быть готовый чек-лист правок"
    assert all(item["title"] for item in fixes)


def test_seo_analyzer_slow_page_is_critical() -> None:
    page = PageData(url="https://site.ru/", html=seo_analyzer.demo_html(), response_ms=4000)
    result = plain(seo_analyzer.analyze_page(page))
    codes = [finding["code"] for finding in result["findings"]]
    assert any("speed" in code or "slow" in code for code in codes), codes


# ──────────────────────────── Гео ────────────────────────────


def test_geo_analyzer_recommends_corrections() -> None:
    plan = plain(geo_analyzer.analyze_geo(geo_analyzer.demo_stats(), target_cpa_rub=1800.0))
    assert len(plan["advices"]) >= 3
    assert plan["summary"]["average_cpa_rub"] > 0
    actions = {item["action"] for item in plan["advices"]}
    assert "pause" in actions, "убыточный регион должен быть остановлен"
    assert actions & {"increase", "decrease"}, "нужны корректировки ставок по регионам"


# ──────────────────────────── Рынок ────────────────────────────


def test_market_analyzer_gives_plan() -> None:
    plan = plain(market_analyzer.analyze_market(niche="климат", region_code=213, monthly_budget_rub=80000.0))
    assert plan["market_cpc_rub"] > 0
    assert plan["competition"]
    assert len(plan["budget_plan"]) == 4, "четыре канала: поиск, сети, бренд, ретаргетинг"
    assert plan["advice"]


def test_market_analyzer_unknown_niche_works() -> None:
    plan = plain(market_analyzer.analyze_market(niche="что-то своё", region_code=2, monthly_budget_rub=30000.0))
    assert plan["market_cpc_rub"] > 0, "неизвестная ниша не должна ломать расчёт"


# ──────────────────────────── Бюджет ────────────────────────────


def test_budget_allocator_redistributes() -> None:
    plan = plain(budget_allocator.allocate_budget(budget_allocator.build_demo_channels(), target_cpa_rub=1500.0))
    assert len(plan["rows"]) == 4
    summary = plan["summary"]
    assert summary["daily_budget_rub"] > 0
    assert summary["increase"] + summary["decrease"] + summary["test"] >= 2
    assert "freed_daily_rub" in summary
    for row in plan["rows"]:
        assert row["new_daily_budget_rub"] >= 0
        assert row["reason"]


def test_budget_allocator_no_division_by_zero() -> None:
    """Кампания без данных не должна ломать распределение."""
    channels = [
        budget_allocator.ChannelStat("c1", "Пустая кампания", 1000, clicks=0, impressions=0, cost_rub=0.0, conversions=0.0),
        budget_allocator.ChannelStat("c2", "Рабочая кампания", 1000, clicks=100, impressions=5000, cost_rub=9000.0, conversions=9.0),
    ]
    plan = plain(budget_allocator.allocate_budget(channels, target_cpa_rub=1000.0))
    assert plan["summary"]["daily_budget_rub"] > 0
    assert plan["summary"]["campaigns_without_data"] == 1


# ──────────────────────────── Кампании ────────────────────────────


def test_campaign_manager_normalizes_micros() -> None:
    normalized = campaign_manager.normalize_campaign(
        {"Id": 101, "Name": "Поиск", "DailyBudget": {"Amount": 1_500_000_000, "Mode": "DISTRIBUTED"}, "State": "ON"},
        user_id=1,
    )
    assert normalized["external_id"] == "101"
    assert normalized["daily_budget"] == 1500.0, normalized["daily_budget"]
    assert normalized["status"] == "active"
    assert normalized["user_id"] == 1


def test_campaign_manager_plans_and_applies() -> None:
    # План приходит и объектом из движка, и словарём из базы — обе формы должны работать
    stats = [
        {"keyword_id": "9001", "phrase": "купить климат", "campaign_id": "101",
         "clicks": 30, "impressions": 900, "cost_rub": 12000.0, "conversions": 3},
    ]
    plan_object = bid_optimizer.optimize_bids(stats, target_cpa_rub=1000.0)
    assert plan_object.changes, "движок должен предложить снижение ставки"
    from_object = campaign_manager.plan_from_bid_plan(plan_object)
    assert from_object, "из плана ставок должен получиться план изменений кампании"
    assert from_object[0].kind == "bid"
    assert from_object[0].keyword_id == "9001"
    assert from_object[0].campaign_id == "101"
    assert from_object[0].after < from_object[0].before, from_object[0].to_dict()
    assert from_object[0].after > 0

    from_dict = campaign_manager.plan_from_bid_plan(
        {
            "changes": [
                {
                    "keyword_id": "9002",
                    "phrase": "климат цена",
                    "current_bid_rub": 120.0,
                    "recommended_bid_rub": 90.0,
                    "reason": "дорогая заявка",
                },
            ],
        },
    )
    assert from_dict and from_dict[0].keyword_id == "9002", "словарь из базы тоже должен читаться"

    applied = asyncio.run(campaign_manager.apply_changes(None, from_object, dry_run=True))
    assert applied.ok
    assert applied.to_dict()["applied_count"] == 0
    assert len(applied.skipped) == len(from_object)


def test_campaign_manager_builds_draft() -> None:
    draft = campaign_manager.build_campaign_draft(
        name="Новая кампания",
        daily_budget_rub=1200.0,
        strategy="PAY_FOR_CONVERSION",
        target_cpa_rub=1200.0,
    )
    assert draft["Name"] == "Новая кампания"
    assert draft["DailyBudget"]["Amount"] == 1_200_000_000, draft["DailyBudget"]
