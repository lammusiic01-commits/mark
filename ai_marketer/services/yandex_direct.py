"""Клиент Яндекс.Директа (API v5).

Что умеет:
  • проверять токен и доставать список кампаний;
  • отдавать статистику отчётами (Reports API) с ожиданием готовности;
  • читать и менять ставки фраз;
  • менять дневной бюджет и статус кампании.

Особенности, которые учтены специально:
  • деньги в API v5 — в микроединицах (1 ₽ = 1 000 000), поэтому всё
    проходит через from_micro/to_micro из движка;
  • отчёты формируются асинхронно: ответ 201 означает «подожди и повтори»,
    ждём столько, сколько просит сервис (заголовок Retry-After);
  • лимиты: 5 запросов в секунду на отчёты — клиент сам делает паузы;
  • для агентских аккаунтов нужен заголовок Client-Login.
"""

from __future__ import annotations

import asyncio
import csv
import io
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import httpx

from core.logger import get_logger
from engine import from_micro, to_micro, to_float

log = get_logger(__name__)

# Адреса API: обычный и песочница (для проверки логики без реальных денег)
DIRECT_API_BASE = "https://api.direct.yandex.com/json/v5"
DIRECT_SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5"

# В API v5 деньги передаются в микроединицах. Если ваш аккаунт ждёт рубли,
# поставьте False — клиент начнёт отправлять значения с копейками.
USE_MICROS = True

# Пауза между запросами отчётов: сервис ограничивает 5 запросов в секунду
REPORT_RATE_LIMIT_PAUSE = 0.25

# Максимум ожидания готовности отчёта (секунды)
REPORT_WAIT_TIMEOUT = 180


class DirectError(RuntimeError):
    """Ошибка Директа с текстом, который можно показать пользователю."""

    def __init__(self, message: str, *, code: int | None = None, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail


@dataclass(slots=True)
class DirectClient:
    """Асинхронный клиент Директа. Создаётся на время запроса и закрывается."""

    token: str
    login: str | None = None  # Client-Login для агентских аккаунтов
    sandbox: bool = False
    timeout: float = 60.0
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)
    _report_last_call: float = field(default=0.0, init=False, repr=False)

    @property
    def base_url(self) -> str:
        return DIRECT_SANDBOX_BASE if self.sandbox else DIRECT_API_BASE

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept-Language": "ru",
            "Content-Type": "application/json; charset=utf-8",
        }
        if self.login:
            headers["Client-Login"] = self.login
        return headers

    async def __aenter__(self) -> "DirectClient":
        self._client = httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ─── Базовый вызов ─────────────────────────────────────────

    async def call(
        self,
        service: str,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        retries: int = 2,
    ) -> dict[str, Any]:
        """Вызывает сервис API: /json/v5/{service} с телом {method, params}.

        Повторяет запрос при сетевых сбоях и при ответе «слишком много запросов».
        """
        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns_client = self._client is None
        payload = {"method": method, "params": params or {}}

        attempt = 0
        try:
            while True:
                attempt += 1
                try:
                    response = await client.post(f"{self.base_url}/{service}", json=payload)
                except httpx.HTTPError as error:
                    if attempt > retries:
                        raise DirectError(f"Нет связи с Директом: {error}") from error
                    log.warning("Сбой сети при запросе к Директу — повторяю", service=service, attempt=attempt)
                    await asyncio.sleep(1.5 * attempt)
                    continue

                if response.status_code == 429 and attempt <= retries:
                    pause = to_float(response.headers.get("Retry-After"), 2.0) or 2.0
                    log.warning("Директ просит снизить частоту запросов", pause=pause)
                    await asyncio.sleep(pause)
                    continue

                data = _safe_json(response)
                if response.status_code >= 400 and "error" not in data:
                    raise DirectError(
                        f"Директ вернул ошибку {response.status_code}",
                        code=response.status_code,
                        detail=str(data)[:300],
                    )
                return self._handle_errors(data)
        finally:
            if owns_client:
                await client.aclose()

    @staticmethod
    def _handle_errors(data: Mapping[str, Any]) -> dict[str, Any]:
        """Разбирает ошибки Директа и превращает их в понятный текст."""
        error = data.get("error")
        if isinstance(error, Mapping):
            code = int(to_float(error.get("error_code")))
            message = str(error.get("error_string") or "Ошибка Директа")
            detail = str(error.get("error_detail") or "")
            hints = {
                53: "Токен не подходит для этого аккаунта — проверьте, что он выдан для нужного логина.",
                54: "Токен отозван — получите новый в Яндекс.ОAuth и обновите подключение.",
                56: "У токена нет прав на это действие.",
                152: "Закончились баллы API — попробуйте позже или обратитесь в Яндекс.",
                8000: "Превышен лимит запросов — повторите через минуту.",
                8800: "Слишком много объектов в одном запросе — уменьшите список.",
            }
            if code in hints:
                message = f"{message}. {hints[code]}"
            raise DirectError(message, code=code, detail=detail)
        return dict(data)

    # ─── Аккаунт и кампании ────────────────────────────────────

    async def check_token(self) -> dict[str, Any]:
        """Проверка токена: берём минимальный список кампаний.

        Возвращает сводку для подключения: сколько кампаний, валюта, логин.
        """
        data = await self.call(
            "campaigns",
            "get",
            {"SelectionCriteria": {}, "FieldNames": ["Id", "Name", "Status", "State", "Currency", "DailyBudget"], "Page": {"Limit": 100}},
        )
        campaigns = data.get("result", {}).get("Campaigns", [])
        currency = campaigns[0].get("Currency") if campaigns else "RUB"
        log.info("Токен Директа работает", campaigns=len(campaigns), currency=currency)
        return {"ok": True, "campaigns": len(campaigns), "currency": currency}

    async def get_campaigns(self, *, limit: int = 500) -> list[dict[str, Any]]:
        """Список кампаний с бюджетами (деньги уже в рублях)."""
        data = await self.call(
            "campaigns",
            "get",
            {
                "SelectionCriteria": {},
                "FieldNames": ["Id", "Name", "Status", "State", "StatusPayment", "Currency", "DailyBudget", "StartDate", "Type"],
                "Page": {"Limit": limit},
            },
        )
        campaigns: list[dict[str, Any]] = []
        for item in data.get("result", {}).get("Campaigns", []):
            campaign = dict(item)
            budget = campaign.get("DailyBudget")
            if isinstance(budget, Mapping) and budget.get("Amount") is not None:
                campaign["daily_budget_rub"] = from_micro(budget.get("Amount"))
            else:
                campaign["daily_budget_rub"] = 0.0
            campaigns.append(campaign)
        return campaigns

    async def get_keywords(self, campaign_ids: Sequence[int] | None = None, *, limit: int = 5000) -> list[dict[str, Any]]:
        """Фразы кампаний вместе со ставками (ставки — в рублях)."""
        criteria: dict[str, Any] = {}
        if campaign_ids:
            criteria["CampaignIds"] = list(campaign_ids)
        data = await self.call(
            "keywords",
            "get",
            {
                "SelectionCriteria": criteria,
                "FieldNames": ["Id", "Keyword", "CampaignId", "State", "Status", "Bid", "StrategyPriority"],
                "Page": {"Limit": limit},
            },
        )
        keywords: list[dict[str, Any]] = []
        for item in data.get("result", {}).get("Keywords", []):
            keyword = dict(item)
            keyword["current_bid_rub"] = from_micro(item.get("Bid")) if item.get("Bid") is not None else 0.0
            keywords.append(keyword)
        return keywords

    async def get_bids(self, keyword_ids: Sequence[int], *, limit: int = 10_000) -> list[dict[str, Any]]:
        """Текущие ставки по списку фраз."""
        data = await self.call(
            "bids",
            "get",
            {"SelectionCriteria": {"KeywordIds": list(keyword_ids)}, "FieldNames": ["KeywordId", "Bid", "AuctionBid"], "Page": {"Limit": limit}},
        )
        rows: list[dict[str, Any]] = []
        for item in data.get("result", {}).get("Bids", []):
            rows.append(
                {
                    "keyword_id": item.get("KeywordId"),
                    "bid_rub": from_micro(item.get("Bid")) if item.get("Bid") is not None else 0.0,
                    "auction_bid_rub": from_micro(item.get("AuctionBid")) if item.get("AuctionBid") is not None else None,
                },
            )
        return rows

    async def set_bids(self, bids: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
        """Ставит новые ставки: [{KeywordId, Bid}] — ставка в рублях.

        Возвращает результат с разбором: сколько принято, что не получилось.
        """
        payload: list[dict[str, Any]] = []
        skipped: list[Any] = []
        for item in bids:
            keyword_id = item.get("keyword_id") or item.get("KeywordId")
            amount = item.get("bid_rub") if "bid_rub" in item else item.get("Bid")
            if keyword_id is None or amount is None:
                skipped.append(item)
                continue
            payload.append(
                {
                    "KeywordId": int(to_float(keyword_id)),
                    "Bid": to_micro(to_float(amount)) if USE_MICROS else round(to_float(amount), 2),
                },
            )
        if not payload:
            # Молча ничего не сделать нельзя: иначе кнопка «применить»
            # отчитается об успехе, а ставки останутся прежними.
            log.warning("Нет корректных ставок для отправки", skipped=len(skipped), sample=str(skipped[:2])[:200])
            return {"updated": 0, "errors": [], "skipped": len(skipped)}

        data = await self.call("bids", "set", {"Bids": payload})
        result = data.get("result", {})
        set_results = result.get("SetResults", [])
        errors = [item for item in set_results if item.get("Errors")]
        log.info("Ставки обновлены", requested=len(payload), errors=len(errors), skipped=len(skipped))
        return {"updated": len(set_results) - len(errors), "errors": errors, "skipped": len(skipped)}

    async def update_campaign_budget(self, campaign_id: str | int, daily_budget_rub: float) -> dict[str, Any]:
        """Меняет дневной бюджет кампании (в рублях → микроединицы)."""
        body = {
            "Campaigns": [
                {
                    "Id": int(to_float(campaign_id)),
                    "DailyBudget": {
                        "Amount": to_micro(daily_budget_rub) if USE_MICROS else round(float(daily_budget_rub), 2),
                        "Mode": "DISTRIBUTED",
                    },
                },
            ],
        }
        data = await self.call("campaigns", "update", body)
        log.info("Бюджет кампании изменён", campaign_id=campaign_id, budget_rub=daily_budget_rub)
        return data.get("result", {})

    async def update_campaign_status(self, campaign_id: str | int, status: str) -> dict[str, Any]:
        """Останавливает или запускает кампанию (SUSPEND / RESUME)."""
        action = "RESUME" if status in {"active", "running", "on"} else "SUSPEND"
        body = {"Campaigns": [{"Id": int(to_float(campaign_id))}]}
        data = await self.call("campaigns", action.lower(), body)
        log.info("Статус кампании изменён", campaign_id=campaign_id, action=action)
        return data.get("result", {})

    # ─── Отчёты ────────────────────────────────────────────────

    async def get_report(
        self,
        *,
        date_from: str,
        date_to: str,
        field_names: Sequence[str],
        report_type: str = "CAMPAIGN_PERFORMANCE_REPORT",
        filters: Sequence[Mapping[str, Any]] | None = None,
        goals: Sequence[str] | None = None,
        attribution_models: Sequence[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Статистика отчётом. Деньги приходят в микроединицах и переводятся в рубли.

        Директ отвечает не сразу: 200 — отчёт готов, 201/202 — нужно подождать.
        Ждём и повторяем, пока не готово (или пока не выйдет время ожидания).
        """
        client = self._client or httpx.AsyncClient(timeout=self.timeout, headers=self._headers())
        owns_client = self._client is None

        body: dict[str, Any] = {
            "params": {
                "SelectionCriteria": {
                    "DateFrom": date_from,
                    "DateTo": date_to,
                    **({"Filter": list(filters)} if filters else {}),
                },
                "FieldNames": list(field_names),
                "ReportName": f"ai-marketer-{date_from}-{date_to}",
                "ReportType": report_type,
                "DateRangeType": "CUSTOM_DATE",
                "Format": "TSV",
                "IncludeVAT": "YES",
                "IncludeDiscount": "NO",
                # Просим микрорубли и переводим сами — так не путаем единицы
                "returnMoneyInMicros": "true",
                "SkipReportHeader": "true",
                "SkipReportSummary": "true",
            },
        }
        if goals:
            body["params"]["Goals"] = list(goals)
        if attribution_models:
            body["params"]["AttributionModels"] = list(attribution_models)

        started = asyncio.get_event_loop().time()
        try:
            while True:
                # Соблюдаем лимит частоты: 5 запросов в секунду
                pause = REPORT_RATE_LIMIT_PAUSE - (asyncio.get_event_loop().time() - self._report_last_call)
                if pause > 0:
                    await asyncio.sleep(pause)
                self._report_last_call = asyncio.get_event_loop().time()

                response = await client.post(f"{self.base_url}/reports", json=body)
                if response.status_code == 200:
                    return _parse_tsv(response.text)
                if response.status_code in (201, 202):
                    wait = to_float(response.headers.get("Retry-After"), 5.0) or 5.0
                    if asyncio.get_event_loop().time() - started > REPORT_WAIT_TIMEOUT:
                        raise DirectError("Отчёт формируется слишком долго — попробуйте позже")
                    log.info("Отчёт ещё готовится", wait_seconds=wait)
                    await asyncio.sleep(wait)
                    continue

                data = _safe_json(response)
                if response.status_code >= 400 and "error" not in data:
                    raise DirectError(f"Отчёт не сформирован (код {response.status_code})", code=response.status_code, detail=response.text[:300])
                self._handle_errors(data)
                raise DirectError("Отчёт не сформирован", detail=response.text[:300])
        finally:
            if owns_client:
                await client.aclose()

    async def keyword_statistics(
        self,
        *,
        date_from: str,
        date_to: str,
        target_cpa_rub: float = 0.0,
    ) -> list[dict[str, Any]]:
        """Готовые данные для оптимизатора ставок: фразы с кликами, расходом и конверсиями."""
        rows = await self.get_report(
            date_from=date_from,
            date_to=date_to,
            field_names=[
                "CampaignId", "CampaignName", "Criteria", "CriteriaId", "Clicks", "Impressions",
                "Cost", "Conversions", "Ctr", "AvgCpc", "ImpressionShare",
            ],
            report_type="CRITERIA_PERFORMANCE_REPORT",
        )
        stats: list[dict[str, Any]] = []
        for row in rows:
            clicks = int(to_float(row.get("Clicks")))
            conversions = to_float(row.get("Conversions"))
            # CriteriaId — идентификатор фразы (по нему меняем ставку),
            # Criteria — сам текст фразы для человека.
            keyword_id = row.get("CriteriaId") or row.get("Criteria") or ""
            stats.append(
                {
                    "keyword_id": str(keyword_id),
                    "phrase": str(row.get("Criteria") or keyword_id or "без фразы"),
                    "campaign_id": str(row.get("CampaignId") or ""),
                    "campaign_name": row.get("CampaignName"),
                    "clicks": clicks,
                    "impressions": int(to_float(row.get("Impressions"))),
                    "cost_rub": from_micro(row.get("Cost")),
                    "conversions": conversions,
                    "ctr": to_float(row.get("Ctr")),
                    "cpc": from_micro(row.get("AvgCpc")),
                    "impression_share": to_float(row.get("ImpressionShare"), 0.0) or None,
                    "target_cpa_rub": target_cpa_rub,
                },
            )
        return stats

    async def campaign_statistics(self, *, date_from: str, date_to: str) -> list[dict[str, Any]]:
        """Статистика по кампаниям — для дашборда и распределения бюджета."""
        rows = await self.get_report(
            date_from=date_from,
            date_to=date_to,
            field_names=[
                "CampaignId", "CampaignName", "Clicks", "Impressions", "Cost",
                "Conversions", "Ctr", "AvgCpc", "CostPerConversion", "ImpressionShare",
            ],
            report_type="CAMPAIGN_PERFORMANCE_REPORT",
        )
        result: list[dict[str, Any]] = []
        for row in rows:
            result.append(
                {
                    "campaign_id": str(row.get("CampaignId") or ""),
                    "name": str(row.get("CampaignName") or "Кампания"),
                    "clicks": int(to_float(row.get("Clicks"))),
                    "impressions": int(to_float(row.get("Impressions"))),
                    "cost_rub": from_micro(row.get("Cost")),
                    "conversions": to_float(row.get("Conversions")),
                    "ctr": to_float(row.get("Ctr")),
                    "cpc_rub": from_micro(row.get("AvgCpc")),
                    "cpa_rub": from_micro(row.get("CostPerConversion")),
                    "impression_share": to_float(row.get("ImpressionShare"), 0.0) or None,
                },
            )
        return result


def attach_visit_costs(
    visits: Sequence[Mapping[str, Any]],
    campaign_stats: Sequence[Mapping[str, Any]],
    *,
    default_cpc_rub: float = 0.0,
) -> list[dict[str, Any]]:
    """Раздаёт расход кампаний по визитам — без этого утечка считается в нулях.

    Директ знает, сколько стоила кампания, но не знает про конкретный визит;
    Метрика знает визит, но не знает денег. Поэтому берём среднюю цену клика
    кампании (расход ÷ клики) и приписываем её каждому визиту из этой кампании.
    Это оценка, а не бухгалтерия: она показывает порядок суммы, которую можно
    вернуть, убрав ботов, — а именно это и нужно человеку в отчёте.
    """
    cpc_by_campaign: dict[str, float] = {}
    for row in campaign_stats:
        campaign_id = str(row.get("campaign_id") or row.get("Id") or "")
        clicks = to_float(row.get("clicks") or row.get("Clicks"))
        cost = to_float(row.get("cost_rub") or row.get("Cost"))
        cpc = to_float(row.get("cpc_rub") or row.get("AvgCpc"))
        if not cpc and clicks > 0:
            cpc = cost / clicks
        if campaign_id:
            cpc_by_campaign[campaign_id] = money_round(cpc)

    if not cpc_by_campaign:
        cpc_by_campaign[""] = money_round(default_cpc_rub)

    total_clicks = sum(to_float(row.get("clicks") or row.get("Clicks")) for row in campaign_stats)
    total_cost = sum(to_float(row.get("cost_rub") or row.get("Cost")) for row in campaign_stats)
    average_cpc = money_round(total_cost / total_clicks) if total_clicks > 0 else money_round(default_cpc_rub)

    enriched: list[dict[str, Any]] = []
    for visit in visits:
        item = dict(visit)
        campaign_id = str(item.get("campaign_id") or "")
        cpc = cpc_by_campaign.get(campaign_id, average_cpc)
        item["cost_rub"] = money_round(cpc if to_float(item.get("cost_rub")) <= 0 else item.get("cost_rub"))
        enriched.append(item)
    return enriched


def money_round(value: float) -> float:
    """Округляет деньги до копеек — чтобы в отчёте не было «1 234.56789 ₽»."""
    return round(to_float(value), 2)


def _safe_json(response: httpx.Response) -> dict[str, Any]:
    """Читает JSON, не падая на HTML-ответах и пустом теле."""
    try:
        data = response.json()
    except Exception:  # noqa: BLE001 — Директ иногда отдаёт текст вместо JSON
        return {}
    return data if isinstance(data, dict) else {}


def _parse_tsv(text: str) -> list[dict[str, Any]]:
    """Разбирает TSV-отчёт в список словарей (первая строка — заголовки)."""
    if not text.strip():
        return []
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    rows = list(reader)
    if not rows:
        return []
    headers = rows[0]
    result: list[dict[str, Any]] = []
    for row in rows[1:]:
        if not row or len(row) < len(headers):
            continue
        result.append({headers[index]: value for index, value in enumerate(row)})
    return result


async def build_client(token: str, login: str | None = None, *, sandbox: bool = False) -> DirectClient:
    """Создаёт готовый клиент (используется сервисным слоем API)."""
    client = DirectClient(token=token, login=login, sandbox=sandbox)
    client._client = httpx.AsyncClient(timeout=client.timeout, headers=client._headers())  # noqa: SLF001 — фабрика внутри модуля
    return client


__all__ = [
    "DIRECT_API_BASE",
    "DIRECT_SANDBOX_BASE",
    "REPORT_WAIT_TIMEOUT",
    "USE_MICROS",
    "DirectClient",
    "DirectError",
    "attach_visit_costs",
    "build_client",
    "money_round",
]
