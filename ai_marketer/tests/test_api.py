"""Тесты API: подпись Telegram, экраны, подключения, платежи и отчёты.

Здесь проверяется то, что делает API настоящим продуктом, а не набором
функций:

  • вход в Mini App: подпись initData проверяется по HMAC-SHA256, подделка
    и просроченная сессия получают 401;
  • каждый экран отвечает на авторизованный запрос (данные — на SQLite,
    запросы идут через настоящий ASGI-стек FastAPI);
  • токены сервисов лежат в базе только зашифрованными (Fernet из secrets.env);
  • оплата по СБП: счёт → QR-картинка → зачисление на баланс ровно один раз;
  • отчёты (боты, гипотезы, сайт, гео, рынок) не выдумывают данные: без
    подключённых сервисов возвращают понятную ошибку.

Тесты не требуют интернета и базы данных: сайт для проверки поднимается
локально, Директ и Метрика подменяются предсказуемыми ответами.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import httpx  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker  # noqa: E402

from api.auth import AuthError, sign_init_data, verify_init_data  # noqa: E402
from api.deps import CurrentUser, DbSession, get_db  # noqa: E402
from api.server import create_app  # noqa: E402
from core.config import settings  # noqa: E402
from core.database import make_isolated_engine  # noqa: E402
from core.models import Base, Campaign, User  # noqa: E402
from core.security import get_secret_box  # noqa: E402

TG_ID = 777001


def check(name: str, condition: bool, detail: str = "") -> bool:
    """Проверка условия с понятным текстом. Падение = падение теста."""
    assert condition, f"{name}" + (f" — {detail}" if detail else "")
    return True


TG_ID = 777001
TG_USER = {"id": TG_ID, "first_name": "Игорь", "username": "igor_boss", "language_code": "ru", "is_premium": True}
TOKEN = settings.BOT_TOKEN



def _money_eq(text: str, value: float) -> bool:
    """Сравнивает суммы, не придираясь к виду пробела (в ru-RU он неразрывный)."""
    digits = "".join(ch for ch in str(text) if ch.isdigit())
    expected = "".join(ch for ch in f"{value:.0f}" if ch.isdigit())
    return digits == expected and "₽" in str(text)


# ─────────────────────────── 1. Подпись Telegram ───────────────────────────


def _signature_checks() -> None:

    valid = sign_init_data(TG_USER, TOKEN)
    user = verify_init_data(valid)
    check("валидная подпись проходит", user.id == TG_ID, f"вернулся id={user.id}")
    check("имя пользователя сохранилось", user.first_name == "Игорь", f"{user.first_name}")
    check("приветствие знает имя", user.display_name == "Игорь", user.display_name)

    # Подделка: меняем user, оставляя старую подпись
    fake = valid.replace("igor_boss", "hacker")
    try:
        verify_init_data(fake)
        check("подделанная подпись отклонена", False, "подпись прошла проверку!")
    except AuthError as error:
        check("подделанная подпись отклонена", True)
        check("причина понятна человеку", "заново" in str(error) or "подпись" in str(error).lower(), str(error))

    try:
        verify_init_data(valid, bot_token="1234567890:WRONG-TOKEN-AAAAAAAAAAAAAAAAAAAA")
        check("чужой токен бота отклонён", False, "подпись прошла с чужим токеном")
    except AuthError:
        check("чужой токен бота отклонён", True)

    old = sign_init_data(TG_USER, TOKEN, auth_date=int(time.time()) - 3 * 24 * 60 * 60)
    try:
        verify_init_data(old)
        check("устаревшая сессия отклонена", False, "сессия трёхдневной давности принята")
    except AuthError as error:
        check("устаревшая сессия отклонена", True)
        check("текст про устаревание", "устарел" in str(error), str(error))

    check("пустая строка отклонена", _raises_auth(lambda: verify_init_data("")), "пустая строка прошла")
    check(
        "строка без user отклонена",
        _raises_auth(lambda: verify_init_data("auth_date=1&hash=abc")),
    )

    from api.auth import data_check_string, mask_init_data, secret_key

    pairs = [("hash", "x"), ("user", "{}"), ("auth_date", "1")]
    check("строка подписи без hash и по алфавиту", data_check_string(pairs) == "auth_date=1\nuser={}", data_check_string(pairs))
    check("секретный ключ не пустой", len(secret_key(TOKEN)) == 32, str(len(secret_key(TOKEN))))
    check("initData маскируется в логах", "igor" not in mask_init_data(valid), mask_init_data(valid)[:40])


def _raises_auth(call) -> bool:
    try:
        call()
        return False
    except AuthError:
        return True


# ─────────────────────────── 2. Экраны через HTTP ───────────────────────────



async def _post_with_profile(client, headers, path: str, target_cpa, *, site_url=None) -> httpx.Response:
    """Вызывает роут с подменённым профилем — так проверяются ветки проверок.

    Подменяем именно зависимость ProfileDep: приложение считает, что у
    пользователя нет цели по заявке (или сайта), и должно ответить понятной
    ошибкой, а не считать на нулях.
    """
    from api.deps import profile_of
    from api.profile import BusinessProfile

    app = client._transport.app  # noqa: SLF001 — доступ к приложению в тесте
    profile = BusinessProfile(
        niche="стройка-ремонт",
        niche_title="Стройка и ремонт",
        region_code=213,
        region_name="Москва",
        monthly_budget_rub=90000.0,
        target_cpa_rub=float(target_cpa or 0.0),
        site_url="" if site_url is None else site_url,
    )

    async def fake_profile(session: DbSession, user: CurrentUser) -> BusinessProfile:  # noqa: ARG001
        return profile

    previous = app.dependency_overrides.get(profile_of)
    app.dependency_overrides[profile_of] = fake_profile
    try:
        return await client.post(path, headers=headers)
    finally:
        if previous is None:
            app.dependency_overrides.pop(profile_of, None)
        else:
            app.dependency_overrides[profile_of] = previous


async def _http_checks() -> None:

    engine = make_isolated_engine("sqlite+aiosqlite:////tmp/am-api/smoke.db")
    Path("/tmp/am-api/smoke.db").unlink(missing_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_db():
        async for session in _session_gen(session_factory):
            yield session

    app = create_app()
    app.dependency_overrides[get_db] = override_db
    check("роуты зарегистрированы", len(getattr(app.state, "routers", []) or _routers_from_app(app)) >= 6, str(_routers_from_app(app)))

    init_data = sign_init_data(TG_USER, TOKEN)
    headers = {"X-Telegram-Init-Data": init_data}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
        # 2.1 Без подписи — отказ
        no_auth = await client.get("/api/dashboard")
        check("без подписи дашборд недоступен (401)", no_auth.status_code == 401, f"код {no_auth.status_code}")

        bad_auth = await client.get("/api/dashboard", headers={"X-Telegram-Init-Data": "auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef"})
        check("подделанная подпись даёт 401", bad_auth.status_code == 401, f"код {bad_auth.status_code}")

        tma_auth = await client.get(
            "/api/dashboard",
            headers={"Authorization": f"tma {init_data}"},
        )
        check("подпись работает и через Authorization: tma", tma_auth.status_code == 200, f"код {tma_auth.status_code}")

        # 2.2 Онбординг
        onboarding = await client.get("/api/onboarding", headers=headers)
        check("онбординг отдаётся (200)", onboarding.status_code == 200, f"код {onboarding.status_code}")
        ob = onboarding.json()
        check("пять шагов онбординга", ob["total_steps"] == 5, str(ob["total_steps"]))
        check("шаги содержат подсказки по ключам", any(step.get("accordions") for step in ob["steps"]))
        check("список ниш заполнен", len(ob["niches"]) >= 10, str(len(ob["niches"])))
        check("ниши с ориентиром цены клика", all(item["cpc_from_rub"] > 0 for item in ob["niches"]))
        check("список регионов заполнен", len(ob["regions"]) >= 20, str(len(ob["regions"])))
        check("Москва первая среди популярных", ob["regions"][0]["name"] == "Москва", ob["regions"][0]["name"])
        check("подсказка «где взять ключ» про Директ", any("Директ" in item["title"] for item in ob["steps"][2]["accordions"]))

        profile_saved = await client.post(
            "/api/onboarding/profile",
            headers=headers,
            json={"niche": "remont_kvartir_net", "region_code": 213},
        )
        check("неизвестная ниша отклонена", profile_saved.status_code == 400, f"код {profile_saved.status_code}")

        profile_ok = await client.post(
            "/api/onboarding/profile",
            headers=headers,
            json={"niche": "стройка-ремонт", "region_code": 213, "monthly_budget_rub": 90000, "target_cpa_rub": 1800, "site_url": "https://example.com"},
        )
        check("профиль бизнеса сохранён", profile_ok.status_code == 200, f"код {profile_ok.status_code}: {profile_ok.text[:120]}")
        saved = profile_ok.json()
        check("ниша сохранена", saved["profile"]["niche"] == "стройка-ремонт", saved["profile"]["niche"])
        check("название региона подставлено", saved["profile"]["region_name"] == "Москва", saved["profile"]["region_name"])
        check("прогресс онбординга посчитан", saved["progress"]["percent"] >= 60, str(saved["progress"]))
        check("цель по заявке сохранена", saved["profile"]["target_cpa_rub"] == 1800, str(saved["profile"]["target_cpa_rub"]))

        progress = await client.post("/api/onboarding/progress", headers=headers, json={"step": "ready", "completed": True})
        check("онбординг завершается", progress.status_code == 200 and progress.json()["completed"] is True)

        # 2.3 Сервисы
        services = await client.get("/api/services", headers=headers)
        check("список сервисов (200)", services.status_code == 200, f"код {services.status_code}")
        svc = services.json()
        check("три сервиса в списке", len(svc["services"]) == 3, str(len(svc["services"])))
        check("пока ничего не подключено", svc["connected_count"] == 0, str(svc["connected_count"]))
        check("без сервисов расчёты не готовы", svc["ready"] is False)

        unknown = await client.post("/api/services/unknown/connect", headers=headers, json={})
        check("неизвестный сервис → 404", unknown.status_code == 404, f"код {unknown.status_code}")

        no_token = await client.post("/api/services/yandex_direct/connect", headers=headers, json={})
        check("пустой токен Директа → 400", no_token.status_code == 400, f"код {no_token.status_code}")

        site_pass = await client.get("/api/services/site/passport", headers=headers, params={"url": "не-адрес"})
        check("кривой адрес сайта → 400", site_pass.status_code == 400, f"код {site_pass.status_code}")

        # 2.4 Дашборд без данных
        dash = await client.get("/api/dashboard", headers=headers)
        check("дашборд открывается без данных (200)", dash.status_code == 200, f"код {dash.status_code}")
        data = dash.json()
        check("четыре метрики 2×2", len(data["metrics"]) == 4, str(len(data["metrics"])))
        check("пустые метрики показывают «—», а не ноль", data["metrics"][0]["text"] == "—", data["metrics"][0]["text"])
        check("баланс нулевой", data["money"]["balance_rub"] == 0, str(data["money"]["balance_rub"]))
        check("совет не пустой", len(data["advice"]["text"]) > 40, data["advice"]["text"][:60])
        check("совет собран шаблоном (без ключа ИИ)", data["advice"]["source"] == "template", data["advice"]["source"])
        check("приветствие по имени", "Игорь" in data["greeting"], data["greeting"])
        check("защита от ботов сообщает об отсутствии отчёта", data["bot_shield"]["has_report"] is False)
        check("уровень риска без данных", data["bot_shield"]["risk_level"] == "нет данных", data["bot_shield"]["risk_level"])
        check("профиль в дашборде", data["profile"]["niche"] == "стройка-ремонт", data["profile"]["niche"])
        check("онбординг отмечен пройденным", data["user"]["onboarding_completed"] is True)

        # 2.5 Платежи
        balance = await client.get("/api/payments/balance", headers=headers)
        check("баланс отдаётся (200)", balance.status_code == 200, f"код {balance.status_code}")
        bal = balance.json()
        check("пресеты сумм", bal["presets"] == [500, 1000, 3000, 10000], str(bal["presets"]))
        check("баланс текстом по-русски", _money_eq(bal["balance_text"], 0), repr(bal["balance_text"]))

        small = await client.post("/api/payments/topup", headers=headers, json={"amount": 10})
        check("слишком маленькая сумма отклонена", small.status_code == 400, f"код {small.status_code}")

        topup = await client.post("/api/payments/topup", headers=headers, json={"amount": 3000})
        check("счёт создан (200)", topup.status_code == 200, f"код {topup.status_code}: {topup.text[:150]}")
        payment = topup.json()
        check("номер платежа формата SBP-", payment["payment_id"].startswith("SBP-"), payment["payment_id"])
        check("сумма округлена", payment["amount"] == 3000.0, str(payment["amount"]))
        check("сумма текстом", _money_eq(payment["amount_text"], 3000), payment["amount_text"])
        qr_bytes = base64.b64decode(payment["qr_png_base64"])
        check("QR-код — настоящий PNG", qr_bytes[:8] == b"\x89PNG\r\n\x1a\n", str(qr_bytes[:8]))
        check("QR-код весит больше килобайта", len(qr_bytes) > 1000, f"{len(qr_bytes)} байт")
        check("подсказка про оплату есть", "QR" in payment["hint"] or "Реквизиты" in payment["hint"])

        status = await client.get(f"/api/payments/{payment['payment_id']}", headers=headers)
        check("статус счёта: ожидает оплаты", status.json()["status"] == "pending", status.json()["status"])

        confirm = await client.post(f"/api/payments/{payment['payment_id']}/confirm", headers=headers)
        check("подтверждение оплаты (200)", confirm.status_code == 200, f"код {confirm.status_code}: {confirm.text[:150]}")
        check("баланс пополнен на 3000 ₽", _money_eq(confirm.json()["balance_text"], 3000), confirm.json()["balance_text"])

        again = await client.post(f"/api/payments/{payment['payment_id']}/confirm", headers=headers)
        check("повторное подтверждение не задваивает деньги", _money_eq(again.json().get("balance_text", ""), 3000), again.text[:120])
        check("повтор называется понятно", "уже зачтена" in again.json().get("message", ""), again.json().get("message", ""))

        history = await client.get("/api/payments/history", headers=headers)
        entries = history.json()["entries"]
        check("операция в журнале", len(entries) == 1 and entries[0]["kind"] == "topup", json.dumps(entries, ensure_ascii=False)[:120])

        foreign = await client.get("/api/payments/SBP-20260101-000000-deadbeef", headers=headers)
        check("чужой платёж → 404", foreign.status_code == 404, f"код {foreign.status_code}")

        # 2.6 Отчёты без подключённых сервисов — понятные ошибки
        bots = await client.post("/api/reports/bots", headers=headers)
        check("отчёт по ботам без Метрики → 409", bots.status_code == 409, f"код {bots.status_code}")
        check("текст ошибки подсказывает, что делать", "Метрик" in bots.json()["detail"], bots.json()["detail"])

        geo = await client.post("/api/reports/geo", headers=headers)
        check("гео без Метрики → 409", geo.status_code == 409, f"код {geo.status_code}")
        check("текст про Метрику", "Метрик" in geo.json()["detail"], geo.json()["detail"])

        geo_no_target = await _post_with_profile(client, headers, "/api/reports/geo", 0)
        check("гео без целевой цены → 400", geo_no_target.status_code == 400, f"код {geo_no_target.status_code}")
        check("подсказывает указать цель по заявке", "целевую цену" in geo_no_target.json()["detail"], geo_no_target.json()["detail"])

        market = await client.post("/api/reports/market", headers=headers)
        check("рынок отчитывается по данным профиля", market.status_code == 200, f"код {market.status_code}: {market.text[:150]}")
        analysis = market.json()["analysis"]
        check("рынок знает нишу", analysis["niche_name"] == "Стройка и ремонт", analysis.get("niche_name"))
        check("рынок называет цену клика", analysis["market_cpc_rub"] > 0, str(analysis["market_cpc_rub"]))
        check("рынок даёт план бюджета", bool(analysis.get("budget_plan")), str(analysis.get("budget_plan"))[:80])
        check("рынок сравнивает с вашими цифрами", "your_cpc_rub" in analysis)
        check("сообщение не содержит «None»", "None" not in market.json()["message"], market.json()["message"])

        site = await client.post("/api/reports/site", headers=headers)
        check(
            "аудит сайта не падает на недоступном сайте",
            site.status_code in {400, 502} and len(site.json().get("detail", "")) > 10,
            f"код {site.status_code}: {site.text[:120]}",
        )
        site_no_url = await _post_with_profile(client, headers, "/api/reports/site", None, site_url="")
        check("аудит сайта без адреса → 400", site_no_url.status_code == 400, f"код {site_no_url.status_code}")
        check("подсказка указать сайт", "адрес сайта" in site_no_url.json()["detail"], site_no_url.json()["detail"])

        overview = await client.get("/api/reports/overview", headers=headers)
        check("обзор отчётов (200)", overview.status_code == 200, f"код {overview.status_code}")
        reports = overview.json()["reports"]
        check("пять видов отчётов", len(reports) == 5, str(len(reports)))
        check("рынок помечен готовым (ниша выбрана)", any(item["key"] == "market" and item["ready"] for item in reports))
        check("боты пока не готовы", any(item["key"] == "bots" and not item["ready"] for item in reports))

        hypotheses_empty = await client.get("/api/reports/hypotheses", headers=headers)
        check("список гипотез пуст, но отдаётся", hypotheses_empty.status_code == 200 and hypotheses_empty.json()["count"] == 0)

        # 2.7 Кампании
        campaigns = await client.get("/api/campaigns", headers=headers)
        check("кампании (200)", campaigns.status_code == 200, f"код {campaigns.status_code}")
        check("кампаний пока нет", campaigns.json()["count"] == 0)
        check("приложение знает, что нужна синхронизация", campaigns.json()["needs_sync"] is True)

        sync = await client.post("/api/campaigns/sync", headers=headers)
        check("синхронизация без Директа → 409", sync.status_code == 409, f"код {sync.status_code}")

        missing = await client.get("/api/campaigns/999", headers=headers)
        check("несуществующая кампания → 404", missing.status_code == 404, f"код {missing.status_code}")

        # 2.8 Сводка для бота
        summary = await client.get("/api/dashboard/summary", headers=headers)
        check("сводка для бота (200)", summary.status_code == 200, f"код {summary.status_code}")
        text = summary.json()["text"]
        check("сводка содержит баланс", "Баланс" in text, text[:80])
        check("сводка не содержит «None»", "None" not in text, text)

        # 2.9 Данные: кампания со статистикой → дашборд считает
        await _insert_campaign(session_factory)

        dash_with_data = await client.get("/api/dashboard", headers=headers)
        payload = dash_with_data.json()
        check("кампания попала в итоги дашборда", payload["totals"]["clicks"] == 240, str(payload["totals"]["clicks"]))
        check("заявки посчитаны", payload["totals"]["conversions"] == 6.0, str(payload["totals"]["conversions"]))
        check("цена заявки посчитана", payload["totals"]["cpa_rub"] == 3000.0, str(payload["totals"]["cpa_rub"]))
        check("CTR посчитан", payload["totals"]["ctr"] == 4.8, str(payload["totals"]["ctr"]))
        check("метрики показывают числа", payload["metrics"][0]["text"] == "240", payload["metrics"][0]["text"])
        check("цена заявки в рублях", _money_eq(payload["metrics"][2]["text"], 3000), repr(payload["metrics"][2]["text"]))
        check("кампания активна", payload["totals"]["daily_budget_rub"] == 3000.0, str(payload["totals"]["daily_budget_rub"]))

        campaigns_after = (await client.get("/api/campaigns", headers=headers)).json()
        check("кампания в списке", campaigns_after["count"] == 1, str(campaigns_after["count"]))
        check("активных кампаний одна", campaigns_after["active_count"] == 1, str(campaigns_after["active_count"]))
        check("сводка по расходам", campaigns_after["summary"]["total_cost_rub"] == 18000.0, str(campaigns_after["summary"]))

        detail = await client.get(f"/api/campaigns/{campaigns_after['campaigns'][0]['id']}", headers=headers)
        check("карточка кампании без Директа отвечает", detail.status_code == 200, f"код {detail.status_code}")
        check("в карточке сказано, что Директ не подключён", "Директ не подключён" in (detail.json().get("note") or ""), str(detail.json().get("note"))[:80])

        plan = await client.post(f"/api/campaigns/{campaigns_after['campaigns'][0]['id']}/plan", headers=headers)
        check("план по кампании считается", plan.status_code == 200, f"код {plan.status_code}: {plan.text[:150]}")
        check("план содержит распределение бюджета", bool(plan.json()["allocation"]["rows"]), str(plan.json()["allocation"])[:120])

        # 2.10 Гипотезы на реальных данных
        build = await client.post("/api/reports/hypotheses", headers=headers)
        check("сбор гипотез (200)", build.status_code == 200, f"код {build.status_code}: {build.text[:200]}")
        built = build.json()
        check("гипотезы созданы", built["created"] > 0, f"создано {built['created']}")
        check("гипотезы с эффектом в рублях", any(item["impact_rub"] > 0 for item in built["hypotheses"]), str(built["total_impact_text"]))
        check("у гипотез есть приоритет", all(item["priority"] > 0 for item in built["hypotheses"]))
        check("у гипотез есть действие", all(item["action"] for item in built["hypotheses"]))
        check("сообщение о сборке", "готово" in built["message"].lower(), built["message"])

        build_again = (await client.post("/api/reports/hypotheses", headers=headers)).json()
        check("повторная сборка не дублирует гипотезы", build_again["created"] == 0 and build_again["updated"] > 0, str(build_again["created"]))

        top = built["hypotheses"][0]
        explained = await client.get(f"/api/reports/hypotheses/{top['id']}/explain", headers=headers)
        check("объяснение гипотезы (200)", explained.status_code == 200, f"код {explained.status_code}")
        check("объяснение не пустое", len(explained.json()["advice"]["text"]) > 30, explained.json()["advice"]["text"][:60])

        applied = await client.post(f"/api/reports/hypotheses/{top['id']}", headers=headers, json={"action": "apply", "comment": "берём в работу"})
        check("гипотеза принята", applied.json()["hypothesis"]["status"] == "applied", str(applied.json()["hypothesis"]["status"]))
        check("дата применения записана", bool(applied.json()["hypothesis"]["applied_at"]))
        check("комментарий сохранён", applied.json()["hypothesis"]["comment"] == "берём в работу")

        rejected = await client.post(f"/api/reports/hypotheses/{top['id']}", headers=headers, json={"action": "reject"})
        check("гипотеза отклонена", rejected.json()["hypothesis"]["status"] == "rejected")

        bad_action = await client.post(f"/api/reports/hypotheses/{top['id']}", headers=headers, json={"action": "delete"})
        check("неизвестное действие → 400", bad_action.status_code == 400, f"код {bad_action.status_code}")

        pending_only = (await client.get("/api/reports/hypotheses?status_filter=pending", headers=headers)).json()
        check("фильтр «в ожидании» работает", pending_only["count"] < built["count"], f"{pending_only['count']} из {built['count']}")
        check("группы по приоритету посчитаны", set(pending_only["groups"]) == {"high", "medium", "low"}, str(set(pending_only["groups"])))

        # 2.11 AI-совет отдельным запросом
        advice = await client.get("/api/dashboard/advice", headers=headers)
        check("совет отдельным запросом (200)", advice.status_code == 200, f"код {advice.status_code}")
        check("совет — текст, а не пустота", len(advice.json()["text"]) > 25, advice.json()["text"][:60])
        check("совет содержит числа из расчётов", "₽" in advice.json()["text"] or "заявок" in advice.json()["text"], advice.json()["text"][:80])
        check("источник совета указан", advice.json()["source"] in {"template", "ai"}, advice.json()["source"])

    await engine.dispose()


async def _session_gen(session_factory):
    async with session_factory() as session:
        yield session


def _routers_from_app(app) -> list[str]:
    return [route.path for route in app.routes if route.path.startswith("/api")]


async def _insert_campaign(session_factory) -> None:
    """Кладём кампанию со статистикой — так делает синхронизация с Директом."""
    async with session_factory() as session:
        user = (await session.execute(__import__("sqlalchemy").select(User))).scalars().first()
        session.add(
            Campaign(
                user_id=user.id,
                external_id="1234567",
                name="Ремонт квартир — Москва",
                status="active",
                daily_budget=3000.0,
                target_cpa=1800.0,
                stats_cache={
                    "period_days": 30,
                    "clicks": 240,
                    "impressions": 5000,
                    "cost_rub": 18000.0,
                    "conversions": 6.0,
                    "cpa_rub": 3000.0,
                    "ctr": 4.8,
                    "cpc_rub": 75.0,
                    "updated_at": "2026-10-12",
                },
            ),
        )
        await session.commit()



def _start_local_site():
    """Поднимает крошечный сайт на localhost — как Tilda-страница клиента.

    Так мы проверяем полный путь подключения сайта: загрузку страницы,
    определение платформы, поиск счётчика Метрики и карту сайта — без
    зависимости от внешней сети.
    """
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    page = (
        "<!doctype html><html lang='ru'><head>"
        "<title>Ремонт квартир в Москве — цена за квадратный метр</title>"
        "<meta name='description' content='Ремонт квартир под ключ за 30 дней. Смета за 10 минут.'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<script type='text/javascript'>"
        "(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};"
        "m[i].l=1*new Date();}) (window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');"
        "ym(98765432, 'init', {});"
        "</script>"
        "<script src='https://static.tildacdn.com/js/tilda-scripts-3.0.min.js'></script>"
        "</head><body><h1>Ремонт квартир под ключ</h1>"
        "<img src='/img/1.jpg' alt='Кухня после ремонта'><img src='/img/2.jpg'>"
        "<a href='/price'>Цены</a><a href='/sitemap.xml'>Карта сайта</a>"
        "</body></html>"
    ).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — интерфейс стандартной библиотеки
            if self.path.startswith("/sitemap.xml"):
                body = b"<?xml version='1.0'?><urlset><url><loc>/</loc></url></urlset>"
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Server", "nginx")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *_args) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}/", server


# ─────────────── 3. Подключение сервисов с проверкой шифрования ───────────────


async def _connection_checks() -> None:

    engine = make_isolated_engine("sqlite+aiosqlite:////tmp/am-api/smoke2.db")
    Path("/tmp/am-api/smoke2.db").unlink(missing_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_db():
        async for session in _session_gen(session_factory):
            yield session

    import api.routes.services as services_module
    from core.security import SecretBox

    app = create_app()
    app.dependency_overrides[get_db] = override_db

    direct_real = services_module.build_direct_client
    metrika_real = services_module.MetrikaClient

    class FakeDirect:
        """Директ, который отвечает «всё хорошо» — проверяем нашу логику, не сеть."""

        def __init__(self, token: str, login: str | None = None, *, fail: bool = False) -> None:
            self.token = token
            self.login = login
            self.fail = fail

        async def check_token(self) -> dict[str, object]:
            if self.fail:
                from services.yandex_direct import DirectError

                raise DirectError("Токен не подходит: проверьте права доступа к Директу")
            return {"campaigns": 4, "currency": "RUB", "login": self.login or "client"}

        async def close(self) -> None:
            return None

    class FakeMetrika:
        """Метрика с двумя счётчиками — проверяем выбор счётчика и сохранение целей."""

        def __init__(self, token: str = "", counter_id: int | None = None) -> None:
            self.token = token
            self.counter_id = counter_id

        async def list_counters(self) -> list[dict[str, object]]:
            if self.token == "bad":
                from services.yandex_metrika import MetrikaError

                raise MetrikaError("Токен Метрики не подходит")
            return [
                {"id": 98765432, "name": "Сайт компании", "site": "example.com"},
                {"id": 12345678, "name": "Лендинг ремонта", "site": "remont.example.com"},
            ]

        async def list_goals(self, counter_id: int | None = None) -> list[dict[str, object]]:
            return [{"id": 1, "name": "Заявка"}, {"id": 2, "name": "Звонок"}]

        async def close(self) -> None:
            return None

    async def fake_build_client(token: str, login: str | None = None, *, sandbox: bool = False) -> FakeDirect:
        return FakeDirect(token, login, fail=token == "bad-token")

    services_module.build_direct_client = fake_build_client
    services_module.MetrikaClient = FakeMetrika

    try:
        init_data = sign_init_data(TG_USER, TOKEN)
        headers = {"X-Telegram-Init-Data": init_data}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as client:
            bad_direct = await client.post("/api/services/yandex_direct/connect", headers=headers, json={"token": "bad-token"})
            check("Директ с плохим токеном → 400", bad_direct.status_code == 400, f"код {bad_direct.status_code}")
            check("ошибка объясняет причину", "Токен" in bad_direct.json()["detail"], bad_direct.json()["detail"])

            ok_direct = await client.post("/api/services/yandex_direct/connect", headers=headers, json={"token": "y0_AgAAAA-direct-token-123", "login": "client"})
            check("Директ подключён (200)", ok_direct.status_code == 200, f"код {ok_direct.status_code}: {ok_direct.text[:150]}")
            direct_service = ok_direct.json()["service"]
            check("сервис отмечен подключённым", direct_service["connected"] is True)
            check("токен не отдаётся наружу", "y0_AgAAAA-direct-token-123" not in ok_direct.text, ok_direct.text[:100])
            check("токен показан маской", direct_service["details"]["token_masked"].startswith("y0_A"), direct_service["details"]["token_masked"])
            check("число кампаний сохранено", direct_service["details"]["campaigns"] == 4, str(direct_service["details"]))

            ok_metrika = await client.post("/api/services/yandex_metrika/connect", headers=headers, json={"token": "metrika-token-456", "counter_id": 12345678})
            check("Метрика подключена (200)", ok_metrika.status_code == 200, f"код {ok_metrika.status_code}: {ok_metrika.text[:150]}")
            metrika_service = ok_metrika.json()["service"]
            check("выбран указанный счётчик", metrika_service["details"]["counter_id"] == 12345678, str(metrika_service["details"]))
            check("название счётчика сохранено", metrika_service["details"]["counter_name"] == "Лендинг ремонта", str(metrika_service["details"]))
            check("цели посчитаны", metrika_service["details"]["goals"] == 2, str(metrika_service["details"]))

            bad_metrika = await client.post("/api/services/yandex_metrika/connect", headers=headers, json={"token": "bad"})
            check("Метрика с плохим токеном → 400", bad_metrika.status_code == 400, f"код {bad_metrika.status_code}")

            local_url, server = _start_local_site()
            try:
                site = await client.post("/api/services/hosting/connect", headers=headers, json={"site_url": local_url})
            finally:
                server.shutdown()
            check("сайт подключён (реальная загрузка страницы)", site.status_code == 200, f"код {site.status_code}: {site.text[:200]}")
            if site.status_code == 200:
                passport = site.json()["passport"]
                check("паспорт сайта содержит код ответа", passport["status_code"] == 200, str(passport.get("status_code")))
                check("платформа определена", bool(passport["platform"]), str(passport.get("platform")))
                check("домен в паспорте", passport["domain"].startswith("127.0.0.1"), str(passport.get("domain")))
                check("платформа распознана как Tilda", "Tilda" in passport["platform_title"] or "Tilda" in passport["platform"], str(passport.get("platform")))
                check("подсказка по платформе", bool(site.json()["hint"]), str(site.json().get("hint"))[:60])

            listing = (await client.get("/api/services", headers=headers)).json()
            check("подключено три сервиса", listing["connected_count"] == 3, str(listing["connected_count"]))
            check("расчёты готовы", listing["ready"] is True)

            # Проверка статуса и отключение
            checked = await client.post("/api/services/yandex_direct/check", headers=headers)
            check("повторная проверка Директа (200)", checked.status_code == 200, f"код {checked.status_code}")
            check("проверка сообщает результат", "на связи" in checked.json()["message"], checked.json()["message"])

            disconnected = await client.delete("/api/services/yandex_metrika", headers=headers)
            check(
                "сервис отключается",
                disconnected.status_code == 200 and disconnected.json()["service"]["connected"] is False,
                f"код {disconnected.status_code}: {disconnected.text[:150]}",
            )

            # Токен лежит в базе только зашифрованным
            from sqlalchemy import select

            from core.models import ServiceConnection

            async with session_factory() as session:
                rows = (
                    await session.execute(select(ServiceConnection).where(ServiceConnection.service_type == "yandex_direct"))
                ).scalars().all()
                stored = rows[0].encrypted_token
                box = SecretBox(settings.ENCRYPTION_KEY)
                check("в базе нет открытого токена", "y0_AgAAAA-direct-token-123" not in stored, stored[:40])
                check("токен расшифровывается обратно", box.decrypt(stored) == "y0_AgAAAA-direct-token-123", box.decrypt(stored)[:20])
                check("шифр помечен версией ключа", stored.startswith("enc:v1:"), stored[:12])

                metrika_rows = (
                    await session.execute(select(ServiceConnection).where(ServiceConnection.service_type == "yandex_metrika"))
                ).scalars().all()
                check("после отключения токен стёрт", metrika_rows[0].encrypted_token == "", metrika_rows[0].encrypted_token[:20])
                check("отключённый сервис не активен", metrika_rows[0].is_active is False, str(metrika_rows[0].is_active))

            # Дашборд видит подключения из базы, не делая сетевых вызовов
            dash = (await client.get("/api/dashboard", headers=headers)).json()
            check("дашборд знает про Директ", dash["direct"]["connected"] is True, str(dash["direct"]))
            check("дашборд знает про кампании в Директе", dash["direct"]["details"]["campaigns"] == 4, str(dash["direct"]["details"]))
            check("дашборд знает про отключённую Метрику", dash["metrika"]["connected"] is False, str(dash["metrika"]))

    finally:
        services_module.build_direct_client = direct_real
        services_module.MetrikaClient = metrika_real
        await engine.dispose()


# ─────────────────────── 4. HTML-паспорт сайта (Tilda/WordPress) ───────────────────────


def _platform_checks() -> None:

    from services.hosting import detect_platform, domain_of, extract_links, normalize_url

    cases = {
        "https://static.tildacdn.com/tilda.js": ("Tilda", "Tilda Publishing"),
        "https://example.com/wp-content/themes/astra/style.css": ("WordPress", "WordPress"),
        "<script id='__NEXT_DATA__'>": ("Next.js", "Next.js"),
        "https://cdn.example.com/bitrix/js/main.js": ("Битрикс", "1С-Битрикс"),
        "<link href='/media/jui/css/x.css'>": ("Joomla", "Joomla"),
        "<div class='w-nav w-layout-grid'>": ("Webflow", "Webflow"),
        "<div data-reactroot=''><div id='root-render'>": ("React", "React SPA"),
    }
    for marker, (code, title) in cases.items():
        found_code, found_title = detect_platform(f"<html><body>{marker}</body></html>")
        check(f"платформа {title} распознана", found_code == code, f"{found_code}/{found_title} по маркеру {marker}")

    check("незнакомый сайт определяется как статика", detect_platform("<html><body>Привет</body></html>")[0] == "статика")
    check("пустой ответ не выдумывает платформу", detect_platform("")[0] == "не определена")

    check("адрес без схемы достраивается", normalize_url("example.com").startswith("https://"), normalize_url("example.com"))
    check("домен отделяется от пути", domain_of("https://example.com/page?x=1") == "example.com", domain_of("https://example.com/page?x=1"))
    links = extract_links('<a href="/price">Цены</a><a href="https://example.com/about">О нас</a>', "https://example.com")
    check("ссылки собираются абсолютными", all(link.startswith("https://example.com") for link in links), str(links))

    from services.hosting import guess_platform_hint

    for code in ("Tilda", "WordPress", "Битрикс", "статика", "не определена"):
        check(f"подсказка по платформе «{code}» не пустая", len(guess_platform_hint(code)) > 20, guess_platform_hint(code)[:40])

    from services.hosting import SiteError, normalize_url as norm

    try:
        norm("ht!tp://плохо")
        check("кривой адрес отклоняется", False, "адрес прошёл проверку")
    except SiteError:
        check("кривой адрес отклоняется", True)




# ─────────────────────────── Тесты для pytest ───────────────────────────


def test_telegram_signature() -> None:
    """Вход в приложение: подпись Telegram проверяется, подделка не проходит."""
    _signature_checks()


def test_api_screens() -> None:
    """Экраны API: онбординг, дашборд, платежи, кампании, отчёты, гипотезы."""
    asyncio.run(_http_checks())


def test_service_connections() -> None:
    """Подключение Директа, Метрики и сайта: проверка токена и шифрование."""
    asyncio.run(_connection_checks())


def test_platform_detection() -> None:
    """Сайт клиента подключается независимо от платформы."""
    _platform_checks()
