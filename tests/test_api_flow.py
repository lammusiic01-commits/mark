"""
Сквозной тест: подписанный initData → синхронизация (фейковые Директ и Метрика)
→ дашборд, кампании, Bot Shield, воронка, отчёты, баланс, A/B тесты.
Внешние API подменены; проверяется вся серверная логика и изоляция пользователей.
"""
import json
import hashlib
import hmac
import time
from datetime import timedelta
from urllib.parse import urlencode

import httpx
import pytest

from app.api.routes import campaigns as campaigns_route
from app.api.routes import services as services_route
from app.database import init_db
from app.main import app
from app.config import settings

BOT = settings.BOT_TOKEN


def signed(user_id: int, name: str) -> dict:
    fields = {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id, "first_name": name})}
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", BOT.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return {"X-Telegram-Init-Data": urlencode(fields)}


class FakeDirect:
    last_action = None

    def __init__(self, token, **_):
        self.token = token

    async def campaigns(self):
        return [
            {"id": 101, "name": "Бренд", "status": "ON", "daily_budget_kop": 50000},
            {"id": 102, "name": "Подозрительная", "status": "ON", "daily_budget_kop": 10000},
        ]

    async def campaign_report(self, date_from, date_to, goal_id=None):
        assert goal_id == "5", "цель Метрики должна передаваться в отчёт"
        rows = []
        for i in range((date_to - date_from).days + 1):
            day = date_from + timedelta(days=i)
            rows.append({"date": day, "campaign_id": 101, "name": "Бренд", "impressions": 1000,
                         "clicks": 50, "cost_kop": 30000, "conversions": 3})
            rows.append({"date": day, "campaign_id": 102, "name": "Подозрительная", "impressions": 300,
                         "clicks": 400 if i == 3 else 60, "cost_kop": 20000, "conversions": 0})
        return rows

    async def set_state(self, campaign_id, action):
        FakeDirect.last_action = (campaign_id, action)


async def fake_metrika(token, counter_id, date_from, date_to):
    out = []
    for i in range((date_to - date_from).days + 1):
        out.append({"date": date_from + timedelta(days=i), "visits": 80, "users": 70, "bounce_rate": 42.0})
    return out


@pytest.mark.asyncio
async def test_full_flow(monkeypatch):
    monkeypatch.setattr(services_route, "DirectClient", FakeDirect)
    monkeypatch.setattr(campaigns_route, "DirectClient", FakeDirect)
    monkeypatch.setattr(services_route, "daily_site_stats", fake_metrika)
    await init_db()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        me = signed(5001, "Анна")
        other = signed(5002, "Борис")

        # 1. Подпись initData: без подписи и с подделкой — 401
        assert (await c.get("/api/dashboard", headers={"X-Telegram-Init-Data": "auth_date=1&hash=x"})).status_code == 401
        bad = dict(me)
        raw = bad["X-Telegram-Init-Data"]
        bad["X-Telegram-Init-Data"] = raw[:-1] + ("0" if raw[-1] != "0" else "1")  # портим hash
        assert (await c.get("/api/dashboard", headers=bad)).status_code == 401

        # 2. Настройка и секреты
        r = await c.put("/api/settings", headers=me, json={
            "yandex_token": "y0_SECRET_TOKEN_XYZ", "metrika_counter_id": "1", "metrika_goal_id": "5",
            "target_cpa_rub": 200, "onboarded": True, "site_url": "example.ru"})
        assert r.status_code == 200
        assert "y0_SECRET_TOKEN_XYZ" not in r.text
        assert r.json()["has_yandex_token"] is True
        with open(settings.DATABASE_URL.replace("sqlite+aiosqlite:///", ""), "rb") as f:
            assert b"y0_SECRET_TOKEN_XYZ" not in f.read(), "токен не должен лежать в БД открытым текстом"

        # 3. Синхронизация
        r = await c.post("/api/services/sync", headers=me, json={"days": 14})
        assert r.status_code == 200, r.text
        sync = r.json()
        assert sync["campaigns"] == 2 and sync["stat_rows"] == 28 and sync["metrika_days"] == 14
        assert sync["conversions_enabled"] is True

        # 4. Дашборд: цифры и риск
        dash = (await c.get("/api/dashboard", headers=me)).json()
        assert dash["connected"] is True
        assert dash["summary"]["clicks"] == 14 * 50 + 13 * 60 + 400
        assert dash["risk"]["risk_count"] >= 1
        assert dash["funnel"]["bottleneck"] is not None
        assert len(dash["series"]) == 14

        # 5. Кампании и детализация
        camps = (await c.get("/api/campaigns", headers=me)).json()["items"]
        assert {x["name"] for x in camps} == {"Бренд", "Подозрительная"}
        cid = next(x["campaign_id"] for x in camps if x["name"] == "Бренд")  # внутренний ID, не ID Директа
        detail = (await c.get(f"/api/campaigns/{cid}", headers=me)).json()
        assert detail["summary"]["conversions"] == 42
        assert detail["recommendation"]["action"] in ("keep", "decrease_bid", "increase_bid")

        # 6. Изоляция: чужой пользователь не видит и не трогает чужие кампании
        assert (await c.get(f"/api/campaigns/{cid}", headers=other)).status_code == 404
        assert (await c.post(f"/api/campaigns/{cid}/suspend", headers=other)).status_code == 404
        other_dash = (await c.get("/api/dashboard", headers=other)).json()
        assert other_dash["summary"]["clicks"] == 0

        # 7. Пауза кампании через Директ (фейк)
        r = await c.post(f"/api/campaigns/{cid}/suspend", headers=me)
        assert r.status_code == 200 and r.json()["status"] == "SUSPENDED"
        assert FakeDirect.last_action == (101, "suspend")

        # 8. Bot Shield, воронка, отчёт
        shield = (await c.get("/api/bot-shield", headers=me)).json()
        assert shield["items"][0]["verdict"] in ("high", "medium")
        funnel = (await c.get("/api/funnel", headers=me)).json()
        assert funnel["has_metrika"] is True and len(funnel["daily"]) == 14
        rep = (await c.post("/api/reports", headers=me, json={"days": 7})).json()
        assert len(rep["kpis"]) == 5 and len(rep["sections"]) == 4
        assert (await c.get(f"/api/reports/{rep['id']}", headers=me)).status_code == 200
        assert (await c.get(f"/api/reports/{rep['id']}", headers=other)).status_code == 404

        # 9. A/B тест
        h = await c.post("/api/hypotheses", headers=me, json={
            "name": "Заголовок", "a_visitors": 2000, "a_conversions": 100,
            "b_visitors": 2000, "b_conversions": 160})
        assert h.status_code == 200 and h.json()["result"]["status"] == "significant"

        # 10. Баланс: пополнение без СБП-реквизитов и подтверждение без прав администратора
        t = await c.post("/api/balance/topup", headers=me, json={"amount_rub": 500})
        assert t.status_code == 200 and t.json()["payment"] is None
        assert (await c.post(f"/api/balance/admin/confirm/{t.json()['transaction']['id']}", headers=me)).status_code == 403

        # 11. AI-совет без ключа: скрипт отвечает всегда
        adv = (await c.post("/api/dashboard/advice", headers=me, json={})).json()
        assert adv["script"] and adv["ai_used"] is False

        # 12. Бюджет: ROI-подсказки из реальных данных
        d = (await c.get("/api/roi/defaults", headers=me)).json()
        assert d["has_data"] is True and d["cpc_rub"] > 0

        # 13. Удаление своего теста
        assert (await c.delete(f"/api/hypotheses/{h.json()['id']}", headers=me)).status_code == 200
