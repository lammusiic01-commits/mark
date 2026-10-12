"""Защита от SSRF: пользователь не должен заставить сервер ходить во внутренние сети."""
import asyncio
import ipaddress
import socket
from urllib.parse import urlparse


class UnsafeUrlError(ValueError):
    pass


def normalize_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise UnsafeUrlError("Укажи адрес сайта")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _check_sync(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeUrlError("Разрешены только http и https")
    host = parsed.hostname
    if not host:
        raise UnsafeUrlError("Некорректный адрес")
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as e:
        raise UnsafeUrlError("Домен не найден") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise UnsafeUrlError("Адрес ведёт во внутреннюю сеть и запрещён")


async def assert_public_url(raw: str) -> str:
    """Возвращает нормализованный URL или бросает UnsafeUrlError."""
    url = normalize_url(raw)
    await asyncio.to_thread(_check_sync, url)
    return url
