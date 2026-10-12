"""
Клиент Яндекс Директ API v5 (JSON-методы кампаний и TSV-отчёты).
Документация: https://yandex.ru/dev/direct/doc/ru/
"""
import asyncio
import uuid
from datetime import date

import aiohttp

DIRECT_BASE = "https://api.direct.yandex.com/json/v5"
REPORT_RETRIES = 8


class DirectError(Exception):
    pass


class DirectClient:
    def __init__(self, token: str, timeout: int = 30) -> None:
        if not token:
            raise DirectError("Не задан токен Яндекс Директ")
        self._token = token
        self._timeout = aiohttp.ClientTimeout(total=timeout)

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept-Language": "ru",
            "Content-Type": "application/json; charset=utf-8",
        }
        if extra:
            headers.update(extra)
        return headers

    async def _call(self, service: str, method: str, params: dict) -> dict:
        body = {"method": method, "params": params}
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            async with session.post(f"{DIRECT_BASE}/{service}", json=body,
                                    headers=self._headers()) as resp:
                data = await resp.json(content_type=None)
        if "error" in data:
            err = data["error"]
            raise DirectError(f"{err.get('error_code')}: {err.get('error_string')} — "
                              f"{err.get('error_detail', '')}".strip(" —"))
        return data.get("result", {})

    async def campaigns(self) -> list[dict]:
        result = await self._call("campaigns", "get", {
            "SelectionCriteria": {},
            "FieldNames": ["Id", "Name", "Status", "State", "DailyBudget"],
        })
        out = []
        for c in result.get("Campaigns", []):
            budget = (c.get("DailyBudget") or {}).get("Amount", 0) or 0
            out.append({
                "id": int(c["Id"]),
                "name": c.get("Name", ""),
                "status": c.get("State") or c.get("Status", "UNKNOWN"),
                "daily_budget_kop": int(budget) // 10_000,  # микро-рубли → копейки
            })
        return out

    async def set_state(self, campaign_id: int, action: str) -> None:
        """action: 'suspend' или 'resume'."""
        if action not in ("suspend", "resume"):
            raise DirectError("Недопустимое действие")
        key = "SuspendResults" if action == "suspend" else "ResumeResults"
        result = await self._call("campaigns", action, {
            "SelectionCriteria": {"Ids": [campaign_id]},
        })
        for item in result.get(key, []):
            errors = item.get("Errors") or []
            if errors:
                raise DirectError("; ".join(e.get("Message", "ошибка") for e in errors))

    async def campaign_report(self, date_from: date, date_to: date,
                              goal_id: str | None = None) -> list[dict]:
        """Ежедневная статистика по кампаниям (CAMPAIGN_PERFORMANCE_REPORT, TSV).

        Конверсии Директ отдаёт только если передать Goals (ID цели Метрики) и поле
        Conversions. Тогда колонка называется Conversions_<goal>_<model>, см. _parse_tsv.
        """
        fields = ["Date", "CampaignId", "CampaignName", "Impressions", "Clicks", "Cost"]
        params: dict = {
            "SelectionCriteria": {
                "DateFrom": date_from.isoformat(),
                "DateTo": date_to.isoformat(),
            },
            "FieldNames": fields,
            "ReportName": f"aim-{uuid.uuid4()}",
            "ReportType": "CAMPAIGN_PERFORMANCE_REPORT",
            "DateRangeType": "CUSTOM_DATE",
            "Format": "TSV",
            "IncludeVAT": "NO",
            "IncludeDiscount": "NO",
        }
        if goal_id:
            params["FieldNames"] = fields + ["Conversions"]
            params["Goals"] = [str(goal_id)]
            params["AttributionModels"] = ["LSCCD"]
        body = {"params": params}
        headers = self._headers({"processingMode": "auto", "returnMoneyInMicros": "false",
                                 "skipReportHeader": "true", "skipReportSummary": "true"})
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            for _ in range(REPORT_RETRIES):
                async with session.post(f"{DIRECT_BASE}/reports", json=body, headers=headers) as resp:
                    if resp.status == 200:
                        text = await resp.text()
                        return _parse_tsv(text)
                    if resp.status in (201, 202):
                        retry_in = int(resp.headers.get("retryIn", "5") or 5)
                        await asyncio.sleep(min(retry_in, 30))
                        continue
                    detail = await resp.text()
                    raise DirectError(f"Отчёт не получен (HTTP {resp.status}): {detail[:300]}")
        raise DirectError("Отчёт Директа не готов, попробуй синхронизацию позже")


def _to_int(value: str) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _parse_tsv(text: str) -> list[dict]:
    lines = [ln for ln in text.splitlines()
             if ln.strip() and not ln.startswith('"') and not ln.startswith("Total rows")]
    if len(lines) < 2:
        return []
    header = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        values = dict(zip(header, line.split("\t")))
        try:
            day = date.fromisoformat(values["Date"])
        except (KeyError, ValueError):
            continue
        cost_rub = 0.0
        try:
            cost_rub = float(values.get("Cost", "0") or 0)
        except ValueError:
            cost_rub = 0.0
        conversions = 0
        for key, value in values.items():
            if key == "Conversions" or key.startswith("Conversions_"):
                conversions += _to_int(value)
        rows.append({
            "conversions": conversions,
            "date": day,
            "campaign_id": _to_int(values.get("CampaignId", "0")),
            "name": values.get("CampaignName", ""),
            "impressions": _to_int(values.get("Impressions", "0")),
            "clicks": _to_int(values.get("Clicks", "0")),
            "cost_kop": round(cost_rub * 100),
        })
    return rows
