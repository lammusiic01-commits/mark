"""AI-советник: OpenRouter и превращение расчётов движка в понятный текст.

Важное правило проекта: ИИ не принимает решений. Все цифры и выводы
считает движок (пакет `engine`), а советник лишь пересказывает их
владельцу бизнеса человеческим языком. Если ИИ недоступен, тексты
собираются шаблонами из тех же чисел — приложение работает всегда.
"""

from ai.advisor import (
    Advice,
    advice_for_dashboard,
    advice_payload,
    build_client,
    explain_hypothesis,
    market_advice,
    summarize_bot_report,
    summarize_geo,
    summarize_site_audit,
    weekly_report,
)
from ai.openrouter_client import (
    FREE_MODELS,
    OpenRouterClient,
    OpenRouterError,
    clean_answer,
    numbers_are_grounded,
)

__all__ = [
    "FREE_MODELS",
    "Advice",
    "OpenRouterClient",
    "OpenRouterError",
    "advice_for_dashboard",
    "advice_payload",
    "build_client",
    "clean_answer",
    "explain_hypothesis",
    "market_advice",
    "numbers_are_grounded",
    "summarize_bot_report",
    "summarize_geo",
    "summarize_site_audit",
    "weekly_report",
]
