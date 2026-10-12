from datetime import date, timedelta

import pytest

from app.engine import bid_optimizer, bot_detector, budget_allocator, funnel_analyzer
from app.engine import campaign_manager as cm
from app.engine import hypothesis_engine as he
from app.engine import report_generator, roi_calculator


def _rows(cid, clicks_per_day, conv_total=0, impressions=1000, cost_per_day=1000, days=7):
    start = date(2026, 10, 1)
    out = []
    for i in range(days):
        out.append({"campaign_id": cid, "external_id": cid, "name": f"c{cid}", "status": "ON",
                    "date": start + timedelta(days=i), "impressions": impressions,
                    "clicks": clicks_per_day[i] if isinstance(clicks_per_day, list) else clicks_per_day,
                    "cost_kop": cost_per_day, "conversions": conv_total if i == 0 else 0})
    return out


def test_summarize_basic():
    rows = _rows(1, 10, conv_total=0, days=2)
    s = cm.summarize(rows)
    assert s["clicks"] == 20 and s["cost_kop"] == 2000
    assert s["ctr"] == 1.0 and s["cpc_kop"] == 100 and s["cpa_kop"] is None


def test_group_sorted_by_cost():
    rows = _rows(1, 10, cost_per_day=100) + _rows(2, 10, cost_per_day=900)
    groups = cm.group_campaigns(rows)
    assert [g["campaign_id"] for g in groups] == [2, 1]


def test_bot_detector_flags_no_conversions_and_spike():
    rows = _rows(1, [5, 5, 5, 200, 5, 5, 5], conv_total=0, impressions=300, cost_per_day=500)
    result = bot_detector.analyze(cm.group_campaigns(rows))
    item = result["items"][0]
    assert item["score"] >= 60 and item["verdict"] == "high"
    assert any("без единой конверсии" in f for f in item["flags"])
    assert any("Всплеск" in f for f in item["flags"])
    assert result["wasted_kop"] > 0


def test_bot_detector_clean_campaign():
    rows = _rows(3, 10, conv_total=5, impressions=500, cost_per_day=5000)
    item = bot_detector.analyze(cm.group_campaigns(rows))["items"][0]
    assert item["verdict"] == "low" and item["flags"] == []


def test_bid_optimizer_actions():
    expensive = cm.group_campaigns(_rows(1, 20, conv_total=1, cost_per_day=5000))
    rec = bid_optimizer.recommend(expensive, target_cpa_kop=1000)[0]
    assert rec["action"] == "decrease_bid" and rec["bid_change_pct"] < 0

    no_conv = cm.group_campaigns(_rows(2, 40, conv_total=0, cost_per_day=1000))
    assert bid_optimizer.recommend(no_conv, 1000)[0]["action"] == "pause"

    no_target = bid_optimizer.recommend(expensive, 0)[0]
    assert no_target["action"] == "keep"


def test_ztest_identical_groups_no_difference():
    r = he.two_proportion_ztest(50, 1000, 50, 1000)
    assert r["p_value"] == 1.0 and r["z"] == 0.0


def test_ztest_significant_difference():
    r = he.two_proportion_ztest(50, 1000, 90, 1000)
    assert r["p_value"] < 0.001
    assert r["lift_pct"] == 80.0


def test_evaluate_status_flow():
    assert he.evaluate(0, 0, 10, 1)["status"] == "collecting"
    small = he.evaluate(50, 5, 50, 15)
    assert small["status"] == "collecting" and small["sample_ok"] is False
    big = he.evaluate(2000, 100, 2000, 180)
    assert big["status"] == "significant" and big["winner"] == "B"
    flat = he.evaluate(2000, 100, 2000, 101)
    assert flat["status"] == "no_difference"


def test_ztest_validation():
    with pytest.raises(ValueError):
        he.two_proportion_ztest(5, 0, 1, 10)
    with pytest.raises(ValueError):
        he.two_proportion_ztest(11, 10, 1, 10)


def test_roi_calculator():
    r = roi_calculator.calculate(budget_rub=10000, cpc_rub=20, cr_percent=5,
                                 avg_check_rub=3000, margin_percent=40)
    assert r["clicks"] == 500
    assert r["conversions"] == 25
    assert r["revenue_rub"] == 75000
    assert r["profit_rub"] == pytest.approx(75000 * 0.4 - 10000)
    assert r["breakeven_cpa_rub"] == 1200


def test_roi_calculator_rejects_bad_input():
    with pytest.raises(ValueError):
        roi_calculator.calculate(100, 0, 1, 1, 1)
    with pytest.raises(ValueError):
        roi_calculator.calculate(100, 1, 150, 1, 1)


def test_budget_allocator_sums_exactly_and_respects_min_share():
    campaigns = [
        {"campaign_id": 1, "name": "a", "cost_kop": 1000, "conversions": 10},
        {"campaign_id": 2, "name": "b", "cost_kop": 1000, "conversions": 0},
        {"campaign_id": 3, "name": "c", "cost_kop": 1000, "conversions": 1},
    ]
    out = budget_allocator.allocate(100_001, campaigns)
    assert sum(x["budget_kop"] for x in out) == 100_001
    assert all(x["share_percent"] >= 4.9 for x in out)
    assert out[0]["budget_kop"] > out[2]["budget_kop"]


def test_budget_allocator_equal_split_without_data():
    campaigns = [{"campaign_id": i, "name": str(i), "cost_kop": 0, "conversions": 0} for i in range(3)]
    out = budget_allocator.allocate(3000, campaigns)
    assert [x["budget_kop"] for x in out] == [1000, 1000, 1000]


def test_funnel_bottleneck():
    f = funnel_analyzer.build(impressions=10000, clicks=500, visits=480, conversions=5)
    assert f["bottleneck"] == "Конверсии"
    assert f["stages"][1]["rate_from_prev"] == 5.0


def test_report_builds_sections():
    rows = _rows(1, 10, conv_total=2, cost_per_day=500)
    groups = cm.group_campaigns(rows)
    summary = cm.summarize(rows)
    prev = cm.summarize([])
    funnel = funnel_analyzer.build(summary["impressions"], summary["clicks"], 0, summary["conversions"])
    rep = report_generator.build(7, summary, prev, bot_detector.analyze(groups),
                                 bid_optimizer.recommend(groups, 0), funnel)
    assert len(rep["kpis"]) == 5 and len(rep["sections"]) == 4
    assert rep["kpis"][0]["delta"] is None  # нет прошлого периода — дельты нет
