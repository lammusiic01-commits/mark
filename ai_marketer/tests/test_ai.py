"""Тесты AI-советника: тексты собираются всегда, а цифры не выдумываются.

Главные требования к ИИ в проекте:
  • он только пересказывает расчёты движка, ничего не решает;
  • если модель недоступна или придумала число — отдаём шаблонный текст;
  • экран никогда не остаётся пустым.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from ai import advisor
from ai.openrouter_client import OpenRouterClient, OpenRouterError, clean_answer, numbers_are_grounded
from engine import bot_detector, geo_analyzer, market_analyzer, seo_analyzer
from engine.seo_analyzer import PageData


def fake_client(answer: str, *, status: int = 200, model: str = "meta-llama/llama-3.3-70b-instruct:free") -> OpenRouterClient:
    """Клиент ИИ с подменённым транспортом: отвечает заранее заданным текстом."""

    def handler(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "модель недоступна"}})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": answer}}]})

    client = OpenRouterClient(api_key="sk-or-v1-test-key", model=model)
    client._client = httpx.AsyncClient(  # подмена транспорта только в тестах
        transport=httpx.MockTransport(handler),
        timeout=5.0,
        headers=client._headers(),
    )
    return client


# ──────────────────────────── Чистые функции ────────────────────────────


def test_clean_answer() -> None:
    assert clean_answer("Конечно! Вот анализ: **главное** — клик дорогой.") == "главное — клик дорогой."
    long_text = "Первое предложение. " + "Слово " * 300
    cleaned = clean_answer(long_text)
    assert len(cleaned) <= 1201
    assert cleaned.endswith(("…", "."))


def test_numbers_are_grounded() -> None:
    facts = {"wasted_rub": 8330.0, "risk_score": 82, "share": 33.3}
    assert numbers_are_grounded("Вы теряете 45 000 ₽ на ботах.", facts) is False
    assert numbers_are_grounded("Вы теряете 8 330 ₽ на ботах, риск 82 из 100.", facts) is True
    assert numbers_are_grounded("Доля ботов — 33.3%.", facts) is True
    assert numbers_are_grounded("Доля ботов — 77%.", facts) is False
    # Мелкие числа в тексте — обычная речь, они не считаются выдуманными суммами
    assert numbers_are_grounded("Нужно сделать 2 шага и 3 проверки.", facts) is True


def test_client_chain_and_headers() -> None:
    client = OpenRouterClient(api_key="sk-or-v1-real", model="deepseek/deepseek-chat-v3.1:free")
    chain = client.chain()
    assert chain[0] == "deepseek/deepseek-chat-v3.1:free"
    assert len(chain) >= 4
    assert len(chain) == len(set(chain))

    # Заголовки должны быть ASCII: русское название приложения переводим в латиницу
    headers = client._headers()  # noqa: SLF001 — проверяем содержимое заголовков
    for key, value in headers.items():
        value.encode("ascii")

    assert OpenRouterClient(api_key="").enabled is False
    assert OpenRouterClient(api_key="sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").enabled is False


def test_client_requests() -> None:
    async def scenario() -> None:
        client = fake_client("Клики дешёвые, можно расти.")
        text = await client.chat([{"role": "user", "content": "привет"}])
        assert text == "Клики дешёвые, можно расти."
        await client.close()

        bad = fake_client("", status=401)
        try:
            await bad.chat([{"role": "user", "content": "привет"}])
        except OpenRouterError as error:
            assert error.status == 401
            assert "не принят" in str(error)
        else:  # pragma: no cover — сюда попадать не должны
            raise AssertionError("ошибка ключа не поднялась")
        await bad.close()

        limited = fake_client("", status=429)
        try:
            await limited.chat_with_fallback([{"role": "user", "content": "привет"}])
        except OpenRouterError as error:
            assert "Ни одна модель не ответила" in str(error)
        else:  # pragma: no cover
            raise AssertionError("перебор моделей не завершился ошибкой")
        await limited.close()

        assert (await OpenRouterClient(api_key="").health())["ok"] is False

        good = fake_client("работаю")
        state = await good.health()
        assert state["ok"] is True and state["answer"] == "работаю"
        await good.close()

    asyncio.run(scenario())


# ──────────────────────────── Шаблоны без ИИ ────────────────────────────


def test_templates_use_engine_numbers() -> None:
    report = bot_detector.detect_bots(
        bot_detector.build_demo_visits(days=14, per_day=40),
        conversion_price_rub=1500.0,
    ).to_dict()
    text = advisor.bot_report_template(report)
    assert "₽" in text
    assert ",0 ₽" not in text, "суммы должны быть округлены до рублей"

    dashboard = advisor.dashboard_template(
        {
            "monthly_budget_rub": 85500,
            "wasted_rub": 8330,
            "average_cpa_rub": 1762.22,
            "target_cpa_rub": 1500,
            "conversions": 54,
            "monthly_savings_rub": 12300,
        },
    )
    assert "8 330 ₽" in dashboard
    assert "1 762 ₽" in dashboard
    assert ".0 ₽" not in dashboard

    empty = advisor.dashboard_template({})
    assert "Данных пока мало" in empty

    geo = geo_analyzer.analyze_geo(geo_analyzer.demo_stats(), target_cpa_rub=1800.0).to_dict()
    assert "Хабаровск" in advisor.geo_template(geo)

    market = market_analyzer.analyze_market(niche="климат", region_code=213, monthly_budget_rub=80000.0).to_dict()
    market_text = advisor.market_template(market)
    assert "средний клик стоит" in market_text and "₽" in market_text

    seo = seo_analyzer.analyze_page(
        PageData(url="https://site.ru/", html=seo_analyzer.demo_html(bad=True), response_ms=4200),
    ).to_dict()
    assert "заявк" in advisor.site_template(seo)

    weekly = advisor.weekly_template(
        {
            "period_label": "за неделю",
            "clicks": 320,
            "conversions": 24,
            "cost_rub": 48000,
            "cpa_rub": 2000,
            "suspicious_visits": 40,
            "monthly_savings_rub": 12000,
        },
    )
    assert "320 кликов" in weekly and "24 заявок" in weekly and "48 000 ₽" in weekly


# ──────────────────────────── Путь с ИИ ────────────────────────────


def test_ai_advice_respects_numbers() -> None:
    async def scenario() -> None:
        report = bot_detector.detect_bots(
            bot_detector.build_demo_visits(days=14, per_day=40),
            conversion_price_rub=1500.0,
        ).to_dict()
        wasted = report["wasted_rub"]
        risk = report["risk_score"]

        honest = fake_client(f"На ботов ушло около {wasted:,.0f} ₽, риск {risk} из 100 — стоит закрыть эти источники.".replace(",", " "))
        advice = await advisor.summarize_bot_report(report, client=honest)
        assert advice.source == "ai"
        assert advice.model
        assert "₽" in advice.text
        await honest.close()

        liar = fake_client("На ботов ушло 250 000 ₽ — это очень много.")
        advice = await advisor.summarize_bot_report(report, client=liar)
        assert advice.source == "template", "выдуманную сумму показывать нельзя"
        assert "нет в расчётах" in (advice.reason or "")
        assert f"{wasted:,.0f}".replace(",", " ") in advice.text
        await liar.close()

        broken = fake_client("", status=500)
        advice = await advisor.summarize_bot_report(report, client=broken)
        assert advice.source == "template" and advice.text
        await broken.close()

    asyncio.run(scenario())


def test_every_screen_has_text_without_ai() -> None:
    """Без ключа OpenRouter все экраны всё равно получают текст."""

    async def scenario() -> None:
        report = bot_detector.detect_bots(
            bot_detector.build_demo_visits(days=7, per_day=20),
            conversion_price_rub=1000.0,
        ).to_dict()
        geo = geo_analyzer.analyze_geo(geo_analyzer.demo_stats(), target_cpa_rub=1800.0).to_dict()
        market = market_analyzer.analyze_market(niche="климат", region_code=213, monthly_budget_rub=80000.0).to_dict()
        seo = seo_analyzer.analyze_page(
            PageData(url="https://site.ru/", html=seo_analyzer.demo_html(), response_ms=500),
        ).to_dict()
        hypothesis: dict[str, Any] = {
            "title": "Починить заголовки",
            "description": "Сниппет не цепляет",
            "action": "Переписать title",
            "impact_pct": 12.5,
            "expected_effect_rub": 15000,
            "priority": 70,
            "type": "seo",
        }

        advices = [
            await advisor.summarize_bot_report(report),
            await advisor.summarize_geo(geo),
            await advisor.market_advice(market),
            await advisor.summarize_site_audit(seo),
            await advisor.explain_hypothesis(hypothesis),
            await advisor.weekly_report({"period_label": "за неделю", "clicks": 100, "conversions": 5, "cost_rub": 9000, "cpa_rub": 1800}),
            await advisor.advice_for_dashboard({"wasted_rub": 5000, "average_cpa_rub": 1800, "target_cpa_rub": 1500}, user_name="Иван"),
        ]

        for advice in advices:
            assert advice.text and len(advice.text) > 20
            assert advice.source == "template", "без ключа источник — шаблон"
            assert advice.to_dict()["generated_at"]

        payload = advisor.advice_payload(advices)
        assert len(payload) == 7
        assert all("text" in item and "source" in item for item in payload)
        assert json.dumps(payload, ensure_ascii=False)


def test_advice_is_a_dict_for_api() -> None:
    """Совет отдаётся в API словарём — проверяем контракт."""
    advice = asyncio.run(advisor.advice_for_dashboard({"wasted_rub": 1000, "average_cpa_rub": 900}))
    payload = advice.to_dict()
    assert set(payload) == {"text", "source", "model", "reason", "generated_at"}
    assert payload["source"] in {"ai", "template"}
