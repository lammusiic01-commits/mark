"""Яндекс Метрика: посещения сайта по дням (Stat API)."""
from datetime import date

import aiohttp

METRIKA_STAT_URL = "https://api-metrika.yandex.net/stat/v1/data"


class MetrikaError(Exception):
    pass


async def daily_site_stats(token: str, counter_id: str, date_from: date, date_to: date) -> list[dict]:
    if not token or not counter_id:
        raise MetrikaError("Нужны токен и номер счётчика Метрики")
    params = {
        "ids": counter_id,
        "metrics": "ym:s:visits,ym:s:users,ym:s:bounceRate",
        "dimensions": "ym:s:date",
        "date1": date_from.isoformat(),
        "date2": date_to.isoformat(),
        "sort": "ym:s:date",
        "limit": 1000,
    }
    headers = {"Authorization": f"OAuth {token}"}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.get(METRIKA_STAT_URL, params=params, headers=headers) as resp:
            data = await resp.json(content_type=None)
            if resp.status != 200:
                msg = (data or {}).get("message", f"HTTP {resp.status}")
                raise MetrikaError(f"Метрика: {msg}")

    out = []
    for row in data.get("data", []):
        try:
            day = date.fromisoformat(row["dimensions"][0]["name"])
        except (KeyError, IndexError, ValueError):
            continue
        visits, users, bounce = (row.get("metrics") + [0, 0, 0])[:3]
        out.append({"date": day, "visits": int(visits), "users": int(users),
                    "bounce_rate": round(float(bounce), 2)})
    return out
