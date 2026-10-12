"""Демо-клиенты Яндекса: работа без сети при проверке интерфейса.

Зачем это нужно. Приложение проверяется локально, когда до api.direct.yandex.ru
и api-metrika.yandex.ru доступа нет. Демо-подключения (их создаёт /api/dev/seed)
несут токен-маркер, и API подставляет вместо настоящих клиентов эти: они отвечают
теми же полями, что и Яндекс, но данными из памяти.

Настоящие подключения идут обычным путём — демо-клиент включается только для
токена с маркером, который умеет выдать лишь режим разработки.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from core.logger import get_logger

log = get_logger(__name__)

# Маркеры демо-подключений: попадают в токен при демо-наполнении
DEMO_DIRECT_TOKEN = "DEMO-DIRECT"
DEMO_METRIKA_TOKEN = "DEMO-METRIKA"

# Кампании демо-аккаунта: те же, что в демо-наполнении
DEMO_CAMPAIGNS: list[dict[str, Any]] = [
    {
        "Id": 7100111,
        "Name": "Ремонт квартир — поиск",
        "State": "ON",
        "Status": "ACCEPTED",
        "Type": "TEXT_CAMPAIGN",
        "DailyBudget": {"Amount": 3_000_000_000, "Mode": "STANDARD"},
        "Statistics": {"Clicks": 1180, "Impressions": 41_200, "Cost": 63_720_000_000, "Conversions": 26},
    },
    {
        "Id": 7100222,
        "Name": "Ремонт — РСЯ",
        "State": "ON",
        "Status": "ACCEPTED",
        "Type": "TEXT_CAMPAIGN",
        "DailyBudget": {"Amount": 2_000_000_000, "Mode": "STANDARD"},
        "Statistics": {"Clicks": 940, "Impressions": 96_800, "Cost": 41_360_000_000, "Conversions": 14},
    },
    {
        "Id": 7100333,
        "Name": "Дизайн интерьера — тест",
        "State": "SUSPENDED",
        "Status": "ACCEPTED",
        "Type": "TEXT_CAMPAIGN",
        "DailyBudget": {"Amount": 1_000_000_000, "Mode": "STANDARD"},
        "Statistics": {"Clicks": 260, "Impressions": 12_400, "Cost": 12_480_000_000, "Conversions": 4},
    },
]

DEMO_KEYWORDS: list[dict[str, Any]] = [
    # clicks и conversions — цифры за 30 дней; одна фраза убыточна (заявка дороже
    # цели), у другой заявок нет вовсе: движок предложит и ставку снизить, и фразу убрать
    {"Id": 880011, "Keyword": "ремонт квартир под ключ", "CampaignId": 7100111, "Bid": 54_000_000, "clicks": 118, "conversions": 4},
    {"Id": 880022, "Keyword": "ремонт квартиры цена", "CampaignId": 7100111, "Bid": 54_000_000, "clicks": 96, "conversions": 3},
    {"Id": 880033, "Keyword": "отделка квартир недорого", "CampaignId": 7100222, "Bid": 43_000_000, "clicks": 84, "conversions": 1},
    {"Id": 880044, "Keyword": "дизайн интерьера проект", "CampaignId": 7100333, "Bid": 48_000_000, "clicks": 38, "conversions": 0},
]

# Изменения, которые «принял» Директ во время демо-сессии
_APPLIED: dict[str, Any] = {"campaigns": {}, "bids": []}


def is_demo_token(token: str, marker: str) -> bool:
    """Токен принадлежит демо-подключению?"""
    return bool(token) and token.startswith(marker)


def _state(campaign_id: int) -> str:
    """Текущее состояние кампании с учётом правок демо-сессии."""
    override = _APPLIED["campaigns"].get(int(campaign_id))
    if override:
        return str(override["state"])
    for item in DEMO_CAMPAIGNS:
        if int(item["Id"]) == int(campaign_id):
            return str(item["State"])
    return "ON"


def _budget(campaign_id: int) -> float:
    override = _APPLIED["campaigns"].get(int(campaign_id))
    if override and override.get("daily_budget_rub"):
        return float(override["daily_budget_rub"])
    for item in DEMO_CAMPAIGNS:
        if int(item["Id"]) == int(campaign_id):
            return float(item["DailyBudget"]["Amount"]) / 1_000_000
    return 0.0


class DemoDirectClient:
    """Клиент Директа для проверки: те же методы, данные из памяти."""

    def __init__(self, token: str = DEMO_DIRECT_TOKEN, login: str | None = None) -> None:
        self.token = token
        self.login = login or "remont-demo"
        self.base_url = "https://api.direct.yandex.ru/json/v5 (демо)"

    async def __aenter__(self) -> "DemoDirectClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def check_token(self) -> dict[str, Any]:
        return {"login": self.login, "currency": "RUB", "demo": True}

    async def get_campaigns(self, *, limit: int = 500) -> list[dict[str, Any]]:
        campaigns = []
        for item in DEMO_CAMPAIGNS[:limit]:
            row = dict(item)
            row["State"] = _state(item["Id"])
            row["DailyBudget"] = {**item["DailyBudget"], "Amount": int(_budget(item["Id"]) * 1_000_000)}
            campaigns.append(row)
        log.info("Демо-Директ: отдаю кампании", count=len(campaigns))
        return campaigns

    async def get_keywords(
        self,
        campaign_ids: Sequence[int] | None = None,
        *,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        wanted = {int(item) for item in campaign_ids} if campaign_ids else None
        rows = [item for item in DEMO_KEYWORDS if wanted is None or int(item["CampaignId"]) in wanted]
        return rows[:limit]

    async def get_bids(self, keyword_ids: Sequence[int], *, limit: int = 10_000) -> list[dict[str, Any]]:
        wanted = {int(item) for item in keyword_ids}
        return [
            {"KeywordId": item["Id"], "Bid": item["Bid"], "CampaignId": item["CampaignId"]}
            for item in DEMO_KEYWORDS
            if int(item["Id"]) in wanted
        ][:limit]

    async def set_bids(self, bids: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
        applied = []
        for item in bids:
            keyword_id = int(item.get("KeywordId") or item.get("id") or 0)
            bid = float(item.get("Bid") or item.get("bid") or 0)
            _APPLIED["bids"].append({"keyword_id": keyword_id, "bid": bid})
            applied.append({"KeywordId": keyword_id, "Bid": int(bid)})
        log.info("Демо-Директ: ставки обновлены", count=len(applied))
        return {"Bids": applied}

    async def update_campaign_budget(self, campaign_id: str | int, daily_budget_rub: float) -> dict[str, Any]:
        overrides = _APPLIED["campaigns"].setdefault(int(campaign_id), {})
        overrides["daily_budget_rub"] = float(daily_budget_rub)
        log.info("Демо-Директ: бюджет изменён", campaign=int(campaign_id), budget=float(daily_budget_rub))
        return {"Id": int(campaign_id), "DailyBudget": int(float(daily_budget_rub) * 1_000_000)}

    async def update_campaign_status(self, campaign_id: str | int, status: str) -> dict[str, Any]:
        state = "SUSPENDED" if str(status).upper() in {"SUSPEND", "SUSPENDED", "PAUSE", "PAUSED"} else "ON"
        overrides = _APPLIED["campaigns"].setdefault(int(campaign_id), {})
        overrides["state"] = state
        log.info("Демо-Директ: состояние кампании изменено", campaign=int(campaign_id), state=state)
        return {"Id": int(campaign_id), "State": state}

    async def get_report(
        self,
        report_type: str,
        *,
        fields: Sequence[str],
        date_from: str | None = None,
        date_to: str | None = None,
        **options: Any,
    ) -> list[dict[str, Any]]:
        """Отчёты не нужны для проверки интерфейса: статистика берётся из кэша."""
        log.info("Демо-Директ: отчёт не запрашивается", report=report_type)
        return []

    async def campaign_statistics(self, *, date_from: str, date_to: str) -> list[dict[str, Any]]:
        """Сводка по кампаниям за период — в тех же рублях, что отдаёт Директ."""
        rows: list[dict[str, Any]] = []
        for item in DEMO_CAMPAIGNS:
            clicks = int(item["Statistics"]["Clicks"])
            impressions = int(item["Statistics"]["Impressions"])
            cost_rub = item["Statistics"]["Cost"] / 1_000_000
            conversions = float(item["Statistics"]["Conversions"])
            rows.append(
                {
                    "campaign_id": str(item["Id"]),
                    "name": item["Name"],
                    "clicks": clicks,
                    "impressions": impressions,
                    "cost_rub": round(cost_rub, 2),
                    "conversions": conversions,
                    "ctr": round(100 * clicks / max(impressions, 1), 2),
                    "cpc_rub": round(cost_rub / max(clicks, 1), 2),
                    "cpa_rub": round(cost_rub / conversions, 2) if conversions else 0.0,
                    "impression_share": round(42 + clicks / 100, 1),
                },
            )
        log.info("Демо-Директ: статистика кампаний", count=len(rows))
        return rows

    async def keyword_statistics(
        self,
        *,
        date_from: str,
        date_to: str,
        target_cpa_rub: float = 0.0,
    ) -> list[dict[str, Any]]:
        """Фразы с кликами, расходом и конверсиями — для оптимизатора ставок.

        Одна фраза намеренно убыточна (заявка дороже цели в полтора раза),
        чтобы в демо-режиме появлялись гипотезы по ставкам.
        """
        rows: list[dict[str, Any]] = []
        for index, item in enumerate(DEMO_KEYWORDS):
            clicks = int(item["clicks"])
            conversions = float(item["conversions"])
            cpc_rub = float(item["Bid"]) / 1_000_000
            cost_rub = clicks * cpc_rub
            rows.append(
                {
                    "keyword_id": str(item["Id"]),
                    "phrase": item["Keyword"],
                    "campaign_id": str(item["CampaignId"]),
                    "campaign_name": next(
                        (row["Name"] for row in DEMO_CAMPAIGNS if int(row["Id"]) == int(item["CampaignId"])),
                        "Кампания",
                    ),
                    "clicks": clicks,
                    "impressions": clicks * 34,
                    "cost_rub": round(cost_rub, 2),
                    "conversions": conversions,
                    "ctr": round(100 * clicks / max(clicks * 34, 1), 2),
                    "cpc": round(cpc_rub, 2),
                    "cpa_rub": round(cost_rub / conversions, 2) if conversions else 0.0,
                    "impression_share": round(38 + index * 3.5, 1),
                    "target_cpa_rub": float(target_cpa_rub or 0),
                },
            )
        log.info("Демо-Директ: статистика по фразам", count=len(rows))
        return rows


class DemoMetrikaClient:
    """Клиент Метрики для проверки: цифры похожи на реальные визиты ремонта."""

    def __init__(self, token: str = DEMO_METRIKA_TOKEN, counter_id: int | None = None) -> None:
        self.token = token
        self.counter_id = counter_id or 98_765_432

    async def __aenter__(self) -> "DemoMetrikaClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def check_token(self) -> dict[str, Any]:
        return {"counter_id": self.counter_id, "demo": True}

    async def list_counters(self) -> list[dict[str, Any]]:
        return [{"id": self.counter_id, "name": "Сайт ремонта", "site": "remont-demo.ru"}]

    async def list_goals(self, counter_id: int | None = None) -> list[dict[str, Any]]:
        return [
            {"id": 312001, "name": "Заявка с формы", "is_favorite": True},
            {"id": 312002, "name": "Звонок с сайта", "is_favorite": False},
            {"id": 312003, "name": "Клик по WhatsApp", "is_favorite": False},
        ]

    async def dashboard_metrics(self, *, days: int = 30, counter_id: int | None = None) -> dict[str, Any]:
        return {
            "visits": 4_120,
            "users": 3_680,
            "pageviews": 12_460,
            "bounce_rate": 42.7,
            "avg_duration_seconds": 128,
            "goals": 44,
            "days": days,
        }

    async def by_region(self, *, days: int = 30, counter_id: int | None = None, limit: int = 30) -> list[dict[str, Any]]:
        return [
            {"region_code": 213, "region_name": "Москва", "visits": 1_840, "goals": 21, "bounce_rate": 40.1},
            {"region_code": 1, "region_name": "Москва и область", "visits": 980, "goals": 10, "bounce_rate": 44.6},
            {"region_code": 2, "region_name": "Санкт-Петербург", "visits": 620, "goals": 7, "bounce_rate": 41.2},
            {"region_code": 76, "region_name": "Хабаровск", "visits": 210, "goals": 0, "bounce_rate": 88.4},
        ][:limit]

    async def by_device(self, *, days: int = 30, counter_id: int | None = None) -> list[dict[str, Any]]:
        return [
            {"device": "mobile", "device_name": "Смартфоны", "visits": 2_890, "goals": 31, "bounce_rate": 44.2},
            {"device": "desktop", "device_name": "Компьютеры", "visits": 1_090, "goals": 12, "bounce_rate": 38.6},
            {"device": "tablet", "device_name": "Планшеты", "visits": 140, "goals": 1, "bounce_rate": 47.0},
        ]

    async def by_source(self, *, days: int = 30, counter_id: int | None = None, limit: int = 15) -> list[dict[str, Any]]:
        return [
            {"source": "ad", "source_name": "Реклама", "visits": 2_240, "goals": 32, "bounce_rate": 39.8},
            {"source": "organic", "source_name": "Поиск", "visits": 1_180, "goals": 8, "bounce_rate": 45.5},
            {"source": "direct", "source_name": "Прямые заходы", "visits": 480, "goals": 3, "bounce_rate": 52.1},
            {"source": "referral", "source_name": "Переходы по ссылкам", "visits": 220, "goals": 1, "bounce_rate": 58.3},
        ][:limit]

    async def daily_series(self, *, days: int = 30, counter_id: int | None = None) -> list[dict[str, Any]]:
        start = date.today() - timedelta(days=days - 1)
        series = []
        for offset in range(days):
            day = start + timedelta(days=offset)
            visits = 96 + (offset * 7) % 43
            series.append(
                {
                    "date": day.isoformat(),
                    "visits": visits,
                    "goals": max(visits // 8, 0),
                    "bounce_rate": round(43 + (offset % 5) * 1.7, 1),
                },
            )
        return series

    async def visits(self, *, date_from: str, date_to: str, counter_id: int | None = None) -> list[dict[str, Any]]:
        """Визиты в том же виде, что отдаёт Метрика после нормализации.

        Из них собираются и география, и отчёт детектора ботов. Каждый восьмой
        визит ведёт себя как бот: три секунды, одна страница, ни одной цели.
        Часть визитов помечена антифродом Метрики (is_robot_pro) — самая
        надёжная улика, движок её учитывает отдельно.
        """
        cities = [
            (213, "Москва"),
            (1, "Москва и область"),
            (2, "Санкт-Петербург"),
            (76, "Хабаровск"),
            (54, "Екатеринбург"),
        ]
        phrases = [
            "ремонт квартир под ключ",
            "ремонт квартиры цена",
            "отделка квартир недорого",
            "дизайн интерьера проект",
        ]
        # Визитов примерно столько же, сколько кликов в кампаниях: цифры
        # отчётов должны сходиться с цифрами главного экрана
        total = 2_380
        rows: list[dict[str, Any]] = []
        for index in range(total):
            suspicious = index % 8 == 0
            region_code, region_name = cities[index % len(cities)]
            campaign = DEMO_CAMPAIGNS[index % len(DEMO_CAMPAIGNS)]
            # Хабаровск намеренно без заявок: гео-анализатор предложит его отключить
            goals = 0 if (suspicious or region_code == 76) else (1 if index % 5 == 0 else 0)
            started = datetime.now() - timedelta(minutes=index * 37)
            duration = 3 if suspicious else 74 + index % 40
            page_views = 1 if suspicious else 3 + index % 4
            rows.append(
                {
                    "visit_id": str(900_000 + index),
                    "date": started.date().isoformat(),
                    "hour": started.hour,
                    "duration_seconds": duration,
                    "page_views": page_views,
                    "is_bounce": suspicious,
                    "source": "ad",
                    "user_agent": (
                        "Mozilla/5.0 (compatible; Mail.RU_Bot)"
                        if suspicious
                        else "Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome Mobile 121"
                    ),
                    "ip": f"95.108.{index % 250}.{index % 97}",
                    "region_code": region_code,
                    "region_name": region_name,
                    "conversions": goals,
                    "search_phrase": phrases[index % len(phrases)],
                    "campaign_id": str(campaign["Id"]),
                    "campaign_name": campaign["Name"],
                    # Антифрод Метрики подтверждает каждый шестнадцатый визит
                    "is_robot_pro": index % 16 == 0,
                },
            )
        log.info("Демо-Метрика: визиты готовы", count=len(rows))
        return rows

    async def stat(
        self,
        metrics: Sequence[str],
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        dimensions: Sequence[str] | None = None,
        **options: Any,
    ) -> dict[str, Any]:
        """Общий метод статистики: отдаём ту же форму, что и Яндекс."""
        dimension = (dimensions or ["ym:s:date"])[0]
        if dimension.endswith("date"):
            rows = await self.daily_series(days=30)
            return {"totals": [4_120, 44], "rows": rows, "dimension": dimension}
        rows = await self.by_region()
        return {"totals": [4_120, 44], "rows": rows, "dimension": dimension}
