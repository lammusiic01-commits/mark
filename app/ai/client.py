"""Клиент OpenRouter (бесплатные модели). AI — только советник, не источник расчётов."""
import aiohttp

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class AIError(Exception):
    pass


async def chat(messages: list[dict], api_key: str, model: str) -> str:
    if not api_key:
        raise AIError("Не задан ключ OpenRouter")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/lammusiic01-commits/mark",
        "X-Title": "AI Marketer",
    }
    payload = {"model": model, "messages": messages, "max_tokens": 700, "temperature": 0.3}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        async with session.post(OPENROUTER_URL, json=payload, headers=headers) as resp:
            data = await resp.json(content_type=None)
            if resp.status != 200:
                msg = (data or {}).get("error", {}).get("message", f"HTTP {resp.status}")
                raise AIError(f"OpenRouter: {msg}")
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as e:
        raise AIError("Пустой ответ модели") from e
