"""Внешние сервисы: Яндекс.Директ, Яндекс.Метрика и сайт клиента.

Здесь только обмен данными — ни одного решения о рекламе. Все выводы
делает движок (пакет `engine`), поэтому клиенты ниже максимально простые:
получить, привести единицы, отдать наверх готовый словарь.
"""

from services.hosting import (
    SiteError,
    SitePassport,
    build_passport,
    detect_hosting,
    detect_platform,
    domain_of,
    extract_links,
    fetch_page,
    fetch_paths,
    guess_platform_hint,
    normalize_url,
)
from services.yandex_direct import DirectClient, DirectError, build_client as build_direct_client
from services.yandex_metrika import MetrikaClient, MetrikaError, build_client as build_metrika_client, normalize_visits

__all__ = [
    "DirectClient",
    "DirectError",
    "MetrikaClient",
    "MetrikaError",
    "SiteError",
    "SitePassport",
    "build_direct_client",
    "build_metrika_client",
    "build_passport",
    "detect_hosting",
    "detect_platform",
    "domain_of",
    "extract_links",
    "fetch_page",
    "fetch_paths",
    "guess_platform_hint",
    "normalize_url",
    "normalize_visits",
]
