"""Тесты интеграций: Яндекс.Директ, Яндекс.Метрика и сайт клиента.

Все внешние вызовы подменены: httpx.MockTransport отдаёт заранее известные
ответы (в том числе ошибки и «отчёт ещё не готов»), поэтому тесты проверяют
разбор данных, перевод микрорублей и понятность сообщений об ошибках,
а не наличие интернета.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from engine import to_micro
from engine.bot_detector import detect_bots
from services import (
    DirectClient,
    DirectError,
    MetrikaClient,
    MetrikaError,
    SiteError,
    detect_hosting,
    detect_platform,
    domain_of,
    extract_links,
    guess_platform_hint,
    normalize_url,
    normalize_visits,
)
from services.yandex_direct import attach_visit_costs


def check(condition: bool, message: str = "") -> None:
    """Проверка с внятным сообщением при падении."""
    assert condition, message or "условие не выполнено"


# ──────────────────────────── Хостинг и сайт ────────────────────────────


def test_normalize_url_and_domain() -> None:
    check(normalize_url("tilda.cc/site") == "https://tilda.cc/site")
    check(normalize_url("  http://a.ru/page  ") == "http://a.ru/page")
    check(domain_of("https://www.example.ru/x") == "example.ru")
    with pytest.raises(SiteError):
        normalize_url("")


def test_detect_platform_and_hosting() -> None:
    tilda = (
        '<html><head><title>T</title></head><body class="t-body">'
        '<div class="t-records"></div><script src="https://static.tildacdn.com/x.js"></script></body></html>'
    )
    check(detect_platform(tilda, {})[0] == "Tilda")

    wordpress = '<html><body><link rel="stylesheet" href="/wp-content/themes/x/style.css"></body></html>'
    check(detect_platform(wordpress, {})[0] == "WordPress")

    # Проект на Next.js может жить на Vercel, но подсказку даём про платформу сайта
    nextjs = '<html><body><div id="__next"></div><script src="/_next/static/chunk.js"></script></body></html>'
    check(detect_platform(nextjs, {})[0] == "Next.js", detect_platform(nextjs, {})[0])
    check(detect_platform(nextjs, {"Server": "Vercel"})[0] == "Next.js")

    check(detect_hosting({"Server": "Vercel", "X-Vercel-Id": "fra1::abc"})[0] == "Vercel")
    check(detect_hosting({"cf-ray": "123"})[0] == "Cloudflare")
    check(detect_hosting({"Server": "nginx"})[1] == "nginx")


def test_extract_links_and_hints() -> None:
    html = (
        '<a href="/about">1</a><a href="https://site.ru/2">2</a>'
        '<a href="https://other.ru">3</a><a href="#top">4</a><a href="mailto:a@b.ru">5</a>'
    )
    links = extract_links(html, "https://site.ru/")
    check(links == ["https://site.ru/about", "https://site.ru/2"], str(links))
    check(all("other.ru" not in link and "#" not in link for link in links))
    check("Tilda" in guess_platform_hint("Tilda"))
    check(bool(guess_platform_hint("самописный сайт")))


# ──────────────────────────── Яндекс.Директ ────────────────────────────


def make_direct(handler: Any) -> DirectClient:
    """Клиент Директа на подменённом транспорте."""
    client = DirectClient(token="fake-token", login="agency-login")
    client._client = httpx.AsyncClient(  # подмена транспорта только в тестах
        transport=httpx.MockTransport(handler),
        timeout=5.0,
        headers=client._headers(),
    )
    return client


def test_direct_client_reads_and_writes() -> None:
    """Директ: чтение кампаний, отчёты, ставки и бюджеты — всё в рублях."""

    calls: list[tuple[str, dict[str, Any]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        calls.append((str(request.url), body))
        service = request.url.path.rsplit("/", 1)[-1]
        method = body.get("method")

        if service == "campaigns" and method == "get":
            return httpx.Response(
                200,
                json={
                    "result": {
                        "Campaigns": [
                            {
                                "Id": 101,
                                "Name": "Поиск",
                                "Status": "ACCEPTED",
                                "State": "ON",
                                "Currency": "RUB",
                                "DailyBudget": {"Amount": 1_500_000_000, "Mode": "DISTRIBUTED"},
                            },
                            {"Id": 102, "Name": "Сети", "Status": "ACCEPTED", "State": "SUSPENDED", "Currency": "RUB"},
                        ],
                    },
                },
            )
        if service == "keywords" and method == "get":
            return httpx.Response(
                200,
                json={
                    "result": {
                        "Keywords": [
                            {"Id": 9001, "Keyword": "купить климат", "CampaignId": 101, "Bid": 123_810_000},
                            {"Id": 9002, "Keyword": "климат цена", "CampaignId": 101},
                        ],
                    },
                },
            )
        if service == "bids" and method == "set":
            set_results: list[dict[str, Any]] = [{"KeywordId": item["KeywordId"]} for item in body["params"]["Bids"]]
            if set_results:
                set_results[0]["Errors"] = [{"Code": 1, "Message": "ставка ниже минимума"}]
            return httpx.Response(200, json={"result": {"SetResults": set_results}})
        if service == "campaigns" and method == "update":
            return httpx.Response(200, json={"result": {"UpdateResults": [{}]}})
        if service == "campaigns" and method in {"suspend", "resume"}:
            return httpx.Response(200, json={"result": {"Results": [{}]}})
        if service == "reports":
            check(body["params"]["returnMoneyInMicros"] == "true", "деньги запрашиваем в микроединицах")
            if body["params"]["ReportType"] == "CRITERIA_PERFORMANCE_REPORT":
                return httpx.Response(
                    200,
                    text=(
                        "CampaignId\tCampaignName\tCriteria\tCriteriaId\tClicks\tImpressions\tCost\tConversions\tCtr\tAvgCpc\tImpressionShare\n"
                        "101\tПоиск\tкупить климат\t9001\t14\t320\t1_734_000_000\t2\t4.38\t123_857_142\t61.5\n"
                        "101\tПоиск\tклимат цена\t9002\t9\t180\t900_000_000\t0\t5.00\t100_000_000\t38.2\n"
                        "102\tСети\t—\t9003\t40\t9000\t8_000_000_000\t1\t0.44\t200_000_000\t12.0\n"
                    ),
                )
            return httpx.Response(
                200,
                text=(
                    "CampaignId\tCampaignName\tClicks\tImpressions\tCost\tConversions\tCtr\tAvgCpc\tCostPerConversion\tImpressionShare\n"
                    "101\tПоиск\t23\t500\t2_634_000_000\t2\t4.6\t114_521_739\t1_317_000_000\t61.5\n"
                    "102\tСети\t40\t9000\t8_000_000_000\t1\t0.44\t200_000_000\t8_000_000_000\t12.0\n"
                ),
            )
        return httpx.Response(500, json={"error": {"error_code": 9999, "error_string": "unknown"}})

    async def scenario() -> None:
        client = make_direct(handler)

        state = await client.check_token()
        check(state["ok"] and state["campaigns"] == 2, str(state))

        campaigns = await client.get_campaigns()
        check(campaigns[0]["daily_budget_rub"] == 1500.0, str(campaigns[0]["daily_budget_rub"]))
        check(campaigns[1]["daily_budget_rub"] == 0.0)

        keywords = await client.get_keywords([101])
        check(keywords[0]["current_bid_rub"] == 123.81, str(keywords[0]["current_bid_rub"]))
        check(keywords[1]["current_bid_rub"] == 0.0)

        result = await client.set_bids(
            [
                {"keyword_id": 9001, "bid_rub": 75.5},
                {"keyword_id": 9002, "bid_rub": 109.25},
                {"keyword_id": None, "bid_rub": 10},
            ],
        )
        sent = [call for call in calls if call[0].endswith("/bids") and call[1]["method"] == "set"][0][1]["params"]["Bids"]
        check(sent[0]["Bid"] == to_micro(75.5) == 75_500_000, str(sent[0]))
        check(len(sent) == 2, "мусорная запись без id отфильтрована")
        check(result["updated"] == 1 and len(result["errors"]) == 1, str(result))

        await client.update_campaign_budget(101, 2850.0)
        budget = [call for call in calls if call[1]["method"] == "update"][0][1]["params"]["Campaigns"][0]
        check(budget["DailyBudget"]["Amount"] == 2_850_000_000, str(budget))

        await client.update_campaign_status(102, "paused")
        check(any(call[1]["method"] == "suspend" for call in calls))
        await client.update_campaign_status(102, "active")
        check(any(call[1]["method"] == "resume" for call in calls))

        stats = await client.keyword_statistics(date_from="2026-09-01", date_to="2026-09-30")
        check(len(stats) == 3, f"{len(stats)} строк отчёта")
        check(stats[0]["cost_rub"] == 1734.0, str(stats[0]["cost_rub"]))
        check(stats[0]["cpc"] == 123.86, str(stats[0]["cpc"]))
        check(stats[0]["keyword_id"] == "9001" and stats[0]["phrase"] == "купить климат")
        check(stats[0]["impression_share"] == 61.5)

        campaign_stats = await client.campaign_statistics(date_from="2026-09-01", date_to="2026-09-30")
        check(len(campaign_stats) == 2 and campaign_stats[0]["name"] == "Поиск")
        check(campaign_stats[0]["cpa_rub"] == 1317.0, str(campaign_stats[0]["cpa_rub"]))
        check(campaign_stats[1]["cpa_rub"] == 8000.0)

        await client.close()

    asyncio.run(scenario())


def test_direct_errors_and_retries() -> None:
    """Директ: понятные ошибки, повтор после лимита и защита от вечного ожидания."""

    def error_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"error": {"error_code": 53, "error_string": "Invalid authorization", "error_detail": "token is not allowed"}},
        )

    throttled_calls = {"count": 0}

    def throttled(request: httpx.Request) -> httpx.Response:
        throttled_calls["count"] += 1
        if throttled_calls["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"result": {"Campaigns": []}})

    def forever_preparing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, headers={"Retry-After": "0"})

    async def scenario() -> None:
        import services.yandex_direct as module

        client = make_direct(error_handler)
        with pytest.raises(DirectError) as error:
            await client.get_campaigns()
        check(error.value.code == 53, str(error.value.code))
        check("Токен не подходит" in str(error.value), str(error.value))
        await client.close()

        retry_client = make_direct(throttled)
        await retry_client.call("campaigns", "get", {})
        check(throttled_calls["count"] == 2, f"попыток: {throttled_calls['count']}")
        await retry_client.close()

        original_timeout = module.REPORT_WAIT_TIMEOUT
        module.REPORT_WAIT_TIMEOUT = 1  # в тесте не ждём настоящие три минуты
        try:
            slow = make_direct(forever_preparing)
            with pytest.raises(DirectError) as report_error:
                await slow.get_report(date_from="2026-01-01", date_to="2026-01-02", field_names=["Clicks"])
            check("слишком долго" in str(report_error.value), str(report_error.value))
            await slow.close()
        finally:
            module.REPORT_WAIT_TIMEOUT = original_timeout

    asyncio.run(scenario())


def test_attach_visit_costs() -> None:
    """Расход кампаний раскладывается по визитам — иначе утечка считается в нулях."""
    visits = [
        {"visit_id": "1", "campaign_id": "101", "cost_rub": 0.0},
        {"visit_id": "2", "campaign_id": "102", "cost_rub": 0.0},
        {"visit_id": "3", "campaign_id": None, "cost_rub": 0.0},
    ]
    stats = [
        {"campaign_id": "101", "clicks": 10, "cost_rub": 1000.0},
        {"campaign_id": "102", "clicks": 10, "cost_rub": 3000.0},
    ]
    enriched = attach_visit_costs(visits, stats)
    check(enriched[0]["cost_rub"] == 100.0, str(enriched[0]))
    check(enriched[1]["cost_rub"] == 300.0, str(enriched[1]))
    check(enriched[2]["cost_rub"] == 200.0, str(enriched[2]))
    check(visits[0]["cost_rub"] == 0.0, "исходные данные не меняются")


# ──────────────────────────── Яндекс.Метрика ────────────────────────────


def make_metrika(handler: Any, counter_id: int | None = 555000) -> MetrikaClient:
    client = MetrikaClient(token="fake-oauth", counter_id=counter_id)
    client._client = httpx.AsyncClient(  # подмена транспорта только в тестах
        transport=httpx.MockTransport(handler),
        timeout=5.0,
        headers=client._headers(),
    )
    return client


def metrika_handler(request: httpx.Request) -> httpx.Response:
    """Отвечает как Метрика: счётчики, цели, отчёты и выгрузка визитов."""
    path = request.url.path

    if path == "/management/v1/counters":
        return httpx.Response(
            200,
            json={"counters": [{"id": 555000, "name": "Основной сайт", "site": "site.ru", "status": "Active"}]},
        )
    if path.endswith("/goals"):
        return httpx.Response(
            200,
            json={
                "goals": [
                    {"id": 100, "name": "Заявка", "type": "action"},
                    {"id": 101, "name": "Оплата", "type": "payment"},
                ],
            },
        )
    if path == "/stat/v1/data":
        dimensions = request.url.params.get("dimensions", "")
        if dimensions == "ym:s:regionCity":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"dimensions": [{"id": "213", "name": "Москва"}], "metrics": [1200, 32.5, 12]},
                        {"dimensions": [{"id": "2", "name": "Санкт-Петербург"}], "metrics": [400, 28.0, 6]},
                    ],
                },
            )
        if dimensions == "ym:s:deviceCategory":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"dimensions": [{"id": "2", "name": "Смартфоны"}], "metrics": [1500, 12]},
                        {"dimensions": [{"id": "1", "name": "Компьютеры"}], "metrics": [500, 6]},
                    ],
                },
            )
        if dimensions == "ym:s:lastTrafficSource":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"dimensions": [{"id": "ad", "name": "Реклама"}], "metrics": [900, 25.0, 10]},
                        {"dimensions": [{"id": "organic", "name": "Поисковые системы"}], "metrics": [700, 40.0, 5]},
                    ],
                },
            )
        if dimensions == "ym:s:date":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"dimensions": [{"id": "2026-09-19"}], "metrics": [120, 3]},
                        {"dimensions": [{"id": "2026-09-20"}], "metrics": [140, 5]},
                    ],
                },
            )
        return httpx.Response(200, json={"data": [{"dimensions": [], "metrics": [2000, 1700, 5400, 31.5, 96, 18]}]})
    if path.endswith("/logrequests") and request.method == "POST":
        body = json.loads(request.content.decode())
        # В выгрузку должны идти только существующие поля Logs API
        for field in body["fields"]:
            check(field.startswith("ym:s:"), field)
            check("goalReachesAny" not in field, f"поля {field} нет в Logs API")
        return httpx.Response(200, json={"log_request": {"request_id": 777001, "status": "created"}})
    if path.endswith("/logrequest/777001"):
        return httpx.Response(200, json={"log_request": {"request_id": 777001, "status": "processed"}})
    if "/part/0/download" in path:
        return httpx.Response(
            200,
            text=(
                "ym:s:dateTime\tym:s:visitID\tym:s:visitDuration\tym:s:pageViews\tym:s:bounce\tym:s:goalsID\t"
                "ym:s:lastTrafficSource\tym:s:lastSearchEngine\tym:s:regionCityID\tym:s:isRobotPro\tym:s:userAgent\n"
                "2026-09-20 02:10:00\tv1\t1\t1\t1\t[]\tad\t\t213\t1\tMozilla/5.0 (compatible; PhantomJS/2.1)\n"
                "2026-09-20 14:20:00\tv2\t420\t7\t0\t[123,456]\torganic\tyandex\t2\t0\tMozilla/5.0 Chrome/121\n"
            ),
        )
    if "/part/1/download" in path:
        return httpx.Response(204)
    return httpx.Response(404, json={"message": "not found"})


def test_metrika_reports() -> None:
    """Метрика: сводка, срезы, конверсии и график по дням."""

    async def scenario() -> None:
        client = make_metrika(metrika_handler)

        counters = await client.list_counters()
        check(counters[0]["id"] == 555000 and counters[0]["name"] == "Основной сайт", str(counters))

        state = await client.check_token()
        check(state["ok"] and state["goals"] == 2, str(state))

        metrics = await client.dashboard_metrics(days=30)
        check(metrics["visits"] == 2000 and metrics["conversions"] == 18.0, str(metrics))
        check(metrics["bounce_rate_pct"] == 31.5 and metrics["goals_available"] is True)

        regions = await client.by_region(days=30)
        check(regions[0]["region_name"] == "Москва" and regions[0]["region_code"] == 213, str(regions[0]))
        check(regions[0]["bounce_rate_pct"] == 32.5)
        check(regions[1]["conversions"] == 6.0, str(regions[1]["conversions"]))

        devices = await client.by_device()
        check(devices[0]["device"] == "смартфон" and devices[0]["visits"] == 1500, str(devices[0]))

        sources = await client.by_source()
        check(sources[0]["source"] == "Реклама" and sources[0]["conversions"] == 10.0, str(sources[0]))

        series = await client.daily_series(days=2)
        check(len(series) == 2 and series[0]["date"] == "2026-09-19", str(series))

        await client.close()

    asyncio.run(scenario())


def test_metrika_visits_and_normalization() -> None:
    """Метрика: выгрузка визитов и приведение полей к формату движка."""

    async def scenario() -> None:
        client = make_metrika(metrika_handler)
        visits = await client.visits(date_from="2026-09-01", date_to="2026-09-30")
        check(len(visits) == 2, f"{len(visits)} визитов")

        first, second = visits
        check(first["duration_seconds"] == 1 and first["page_views"] == 1)
        check(first["is_bounce"] is True and second["is_bounce"] is False)
        check(first["source"] == "ad" and second["source"] == "organic", str(first["source"]))
        check(first["hour"] == 2 and second["hour"] == 14, f"{first['hour']} / {second['hour']}")
        check(first["region_code"] == 213 and second["region_code"] == 2)
        check(first["is_robot_pro"] is True and second["is_robot_pro"] is False)
        check(first["conversions"] == 0 and second["conversions"] == 2, str(second["conversions"]))
        check(first["date"] == "2026-09-20" and second["date"] == "2026-09-20", first["date"])

        await client.close()

    asyncio.run(scenario())


def test_metrika_errors() -> None:
    """Метрика: понятные ошибки и запасной набор полей выгрузки."""

    def forbidden(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "Access denied"})

    def rejects_fields(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        if "ym:s:isRobotPro" in body["fields"]:
            return httpx.Response(400, json={"message": "Unknown field ym:s:isRobotPro"})
        return httpx.Response(200, json={"log_request": {"request_id": 1, "status": "created"}})

    async def scenario() -> None:
        bad = make_metrika(forbidden)
        with pytest.raises(MetrikaError) as error:
            await bad.dashboard_metrics()
        check(error.value.code == 403 and "нет доступа" in str(error.value), str(error.value))
        await bad.close()

        without_counter = MetrikaClient(token="x", counter_id=None)
        with pytest.raises(MetrikaError):
            await without_counter.dashboard_metrics()

        fallback = make_metrika(rejects_fields)
        request_id = await fallback.request_logs(date_from="2026-09-01", date_to="2026-09-02")
        check(request_id == 1, f"выгрузка заказана с базовыми полями, id={request_id}")
        await fallback.close()

    asyncio.run(scenario())


def test_metrika_to_bot_detector_pipeline() -> None:
    """Сквозная связка: визиты Метрики + расходы Директа → отчёт о ботах."""

    raw: list[dict[str, Any]] = []
    for index in range(40):
        raw.append(
            {
                "ym:s:dateTime": "2026-09-20 02:15:00",
                "ym:s:visitID": f"bot{index}",
                "ym:s:visitDuration": "0",
                "ym:s:pageViews": "1",
                "ym:s:bounce": "1",
                "ym:s:goalsID": "[]",
                "ym:s:isRobotPro": "1" if index % 2 == 0 else "0",
                "ym:s:lastTrafficSource": "ad",
                "ym:s:lastDirectClickOrder": "101",
                "ym:s:regionCityID": "213",
                "ym:s:userAgent": "Mozilla/5.0 (compatible; PhantomJS/2.1)",
                "ym:s:ipAddress": "10.0.0.7",
                "ym:s:startURL": "https://site.ru/",
            },
        )
    for index in range(30):
        raw.append(
            {
                "ym:s:dateTime": "2026-09-20 15:40:00",
                "ym:s:visitID": f"human{index}",
                "ym:s:visitDuration": "420",
                "ym:s:pageViews": "7",
                "ym:s:bounce": "0",
                "ym:s:goalsID": "[123]" if index % 5 == 0 else "[]",
                "ym:s:lastTrafficSource": "organic",
                "ym:s:lastSearchEngine": "yandex",
                "ym:s:regionCityID": "2",
                "ym:s:userAgent": "Mozilla/5.0 (Macintosh) Chrome/121.0.0.0 Safari/537.36",
                "ym:s:ipAddress": f"10.1.0.{index}",
                "ym:s:startURL": "https://site.ru/catalog",
            },
        )

    visits = normalize_visits(raw)
    check(sum(visit["conversions"] for visit in visits) == 6, str(sum(visit["conversions"] for visit in visits)))
    check(sum(1 for visit in visits if visit["is_robot_pro"]) == 20)

    enriched = attach_visit_costs(visits, [{"campaign_id": "101", "clicks": 40, "cost_rub": 4000.0}])
    report = detect_bots(enriched, conversion_price_rub=1500.0).to_dict()

    codes = [pattern["code"] for pattern in report["patterns"]]
    check("direct-antifraud" in codes, str(codes))
    check("user-agent" in codes, str(codes))
    check("night-activity" in codes, str(codes))
    check(report["suspicious_visits"] >= 40, str(report["suspicious_visits"]))
    check(report["wasted_rub"] > 0, f"{report['wasted_rub']} ₽ утечки")
    check(0 <= report["risk_score"] <= 100, str(report["risk_score"]))
    check(len(report["findings"]) >= 1)


def test_bot_detector_without_antifraud() -> None:
    """Счётчик без Метрики Про: детектор работает на поведении и User-Agent."""
    visits = [
        {
            "date": "2026-09-20",
            "visit_id": f"v{index}",
            "duration_seconds": 1,
            "page_views": 1,
            "user_agent": "",
            "source": "ad",
            "conversions": 0,
            "cost_rub": 40.0,
        }
        for index in range(10)
    ] + [
        {
            "date": "2026-09-20",
            "visit_id": f"h{index}",
            "duration_seconds": 300,
            "page_views": 5,
            "user_agent": "Mozilla/5.0 Chrome/121",
            "source": "organic",
            "conversions": 1,
            "cost_rub": 0.0,
        }
        for index in range(10)
    ]
    report = detect_bots(visits).to_dict()
    check(report["suspicious_visits"] == 10, str(report["suspicious_visits"]))
    check(report["total_visits"] == 20)
