"""Redis: кэш статистики и очередь уведомлений для бота.

Зачем это нужно:
  • кэш — статистика Яндекс.Директа и Метрики обновляется раз в несколько
    минут, а не при каждом открытии Mini App;
  • очередь — API и движок не отправляют сообщения в Telegram сами (бот
    единственный, кто говорит с Telegram), они кладут задание в очередь,
    а бот её разбирает и рассылает уведомления.

Ключевое правило: недоступный Redis не должен ронять ни API, ни бота —
любая операция деградирует в «нет данных» и пишет предупреждение в лог.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any

try:  # пакет может отсутствовать в очень урезанном окружении — тогда кэш просто выключен
    from redis.asyncio import Redis  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Redis = None  # type: ignore[assignment,misc]

from core.config import settings
from core.logger import get_logger

log = get_logger(__name__)

# Очередь уведомлений: продюсеры кладут слева (LPUSH), бот забирает справа (BRPOP)
NOTIFICATIONS_QUEUE = "ai-marketer:notifications"

# Префиксы ключей кэша — единый стиль, чтобы ничего не потерялось
CACHE_DIRECT_STATS = "cache:direct:stats"
CACHE_METRIKA = "cache:metrika"
CACHE_MARKET = "cache:market"

_client: "Redis | None" = None  # type: ignore[valid-type]

# Когда Redis лежит, попытки идут каждую секунду: без этого лог превращается
# в бесконечную простыню одинаковых предупреждений.
_WARN_INTERVAL_SECONDS = 60.0
_last_warn: dict[str, float] = {}


def _warn_throttled(key: str, message: str, **fields: Any) -> None:
    """Пишет предупреждение, но не чаще раза в минуту на один и тот же повод."""
    now = time.monotonic()
    if now - _last_warn.get(key, float("-inf")) < _WARN_INTERVAL_SECONDS:
        return
    _last_warn[key] = now
    log.warning(message, **fields)


def get_client() -> "Redis | None":  # type: ignore[valid-type]
    """Единственное подключение на процесс. None — если пакет не установлен."""
    global _client
    if Redis is None:
        return None
    if _client is None:
        _client = Redis.from_url(
            settings.REDIS_URL,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=5,
            health_check_interval=30,
            retry_on_timeout=True,
        )
    return _client


async def close_client() -> None:
    """Закрывает соединение при остановке приложения."""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception as error:  # noqa: BLE001 — на выключении падать нельзя
            log.warning("Не удалось закрыть соединение с Redis", error=str(error))
        _client = None


async def ping() -> bool:
    """Проверка живости Redis для /health."""
    client = get_client()
    if client is None:
        return False
    try:
        await client.ping()
        return True
    except Exception as error:  # noqa: BLE001
        _warn_throttled("ping", "Redis недоступен", error=str(error))
        return False


# ─── Кэш ───────────────────────────────────────────────────────

async def get_json(key: str, default: Any = None) -> Any:
    """Читает значение из кэша. Любая ошибка → default, без исключения."""
    client = get_client()
    if client is None:
        return default
    try:
        raw = await client.get(key)
    except Exception as error:  # noqa: BLE001
        log.warning("Не удалось прочитать кэш", key=key, error=str(error))
        return default
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("В кэше лежит не JSON — игнорирую", key=key)
        return default


async def set_json(key: str, value: Any, ttl_seconds: int | None = 300) -> bool:
    """Кладёт значение в кэш. ttl_seconds=None — хранить бессрочно."""
    client = get_client()
    if client is None:
        return False
    try:
        payload = json.dumps(value, ensure_ascii=False, default=str)
        if ttl_seconds:
            await client.set(key, payload, ex=ttl_seconds)
        else:
            await client.set(key, payload)
        return True
    except Exception as error:  # noqa: BLE001
        log.warning("Не удалось записать кэш", key=key, error=str(error))
        return False


async def delete(*keys: str) -> int:
    """Удаляет ключи кэша (например, после изменения кампании)."""
    client = get_client()
    if client is None or not keys:
        return 0
    try:
        return int(await client.delete(*keys))
    except Exception as error:  # noqa: BLE001
        log.warning("Не удалось очистить кэш", keys=list(keys), error=str(error))
        return 0


def user_cache_key(prefix: str, user_id: int, *parts: Any) -> str:
    """Единый вид ключа: cache:direct:stats:42:2026-10-01:2026-10-12."""
    tail = ":".join(str(part) for part in parts if part not in (None, ""))
    return f"{prefix}:{user_id}" + (f":{tail}" if tail else "")


# ─── Очередь уведомлений ───────────────────────────────────────

async def push_notification(
    tg_id: int,
    text: str,
    *,
    kind: str = "info",
    reply_markup: dict[str, Any] | None = None,
    silence: bool = False,
) -> bool:
    """Кладёт уведомление в очередь. Отправляет его бот.

    kind: info | success | warning | error — влияет на иконку в сообщении.
    reply_markup: опциональная клавиатура (inline) в виде словаря.
    silence: True — отправить без звука.
    """
    client = get_client()
    if client is None:
        log.warning("Redis недоступен — уведомление не поставлено в очередь", tg_id=tg_id)
        return False

    payload = {
        "tg_id": tg_id,
        "text": text,
        "kind": kind,
        "reply_markup": reply_markup,
        "silence": silence,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await client.lpush(NOTIFICATIONS_QUEUE, json.dumps(payload, ensure_ascii=False))
        log.info("Уведомление поставлено в очередь", tg_id=tg_id, kind=kind)
        return True
    except Exception as error:  # noqa: BLE001
        _warn_throttled("push", "Не удалось поставить уведомление в очередь", tg_id=tg_id, error=str(error))
        return False


async def take_notification(timeout_seconds: int = 5) -> tuple[dict[str, Any] | None, bool]:
    """Ждёт уведомление и сообщает, ответил ли Redis.

    Возвращает (payload, redis_ok):
      • (данные, True)  — уведомление получено;
      • (None,   True)  — очередь пуста, Redis работает;
      • (None,  False)  — Redis недоступен: потребителю нужно выждать паузу,
        иначе цикл будет молотить вхолостую.
    """
    client = get_client()
    if client is None:
        return None, False
    try:
        item = await client.brpop(NOTIFICATIONS_QUEUE, timeout=timeout_seconds)
    except Exception as error:  # noqa: BLE001 — сеть, таймауты, остановка Redis
        _warn_throttled("pop", "Очередь уведомлений недоступна", error=str(error))
        return None, False
    if not item:
        return None, True
    _, raw = item
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("В очереди уведомлений битая запись — пропускаю")
        return None, True
    return (data, True) if isinstance(data, dict) else (None, True)


async def pop_notification(timeout_seconds: int = 5) -> dict[str, Any] | None:
    """Упрощённый вид take_notification: только данные уведомления."""
    payload, _ = await take_notification(timeout_seconds=timeout_seconds)
    return payload


async def queue_size() -> int:
    """Сколько уведомлений ждёт отправки — для диагностики."""
    client = get_client()
    if client is None:
        return 0
    try:
        return int(await client.llen(NOTIFICATIONS_QUEUE))
    except Exception:  # noqa: BLE001
        return 0


__all__ = [
    "CACHE_DIRECT_STATS",
    "CACHE_MARKET",
    "CACHE_METRIKA",
    "NOTIFICATIONS_QUEUE",
    "close_client",
    "delete",
    "get_client",
    "get_json",
    "ping",
    "pop_notification",
    "push_notification",
    "take_notification",
    "queue_size",
    "set_json",
    "user_cache_key",
]
