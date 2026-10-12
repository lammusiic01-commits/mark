"""Зависимости FastAPI: сессия БД, пользователь, подключённые сервисы.

Каждый запрос из Mini App обязан прийти с заголовком X-Telegram-Init-Data.
Из него мы достаём пользователя и дальше работаем только с его данными —
это единственная точка входа, где проверяется доступ.
"""

from __future__ import annotations

from typing import Annotated, AsyncIterator

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.openrouter_client import OpenRouterClient
from api.auth import INIT_DATA_HEADER, AuthError, TelegramUser, verify_init_data
from api.profile import BusinessProfile, load_profile
from core.config import settings
from core.database import get_session as db_session
from core.logger import get_logger
from core.models import ServiceConnection, User, get_or_create_user
from core.security import SecretBox, get_secret_box
from services.hosting import SiteError, build_passport, normalize_url
from services.demo import (
    DEMO_DIRECT_TOKEN,
    DEMO_METRIKA_TOKEN,
    DemoDirectClient,
    DemoMetrikaClient,
    is_demo_token,
)
from services.yandex_direct import DirectClient, build_client as build_direct_client
from services.yandex_metrika import MetrikaClient

log = get_logger(__name__)

# Типы подключений: ровно те, что описаны в ТЗ
SERVICE_DIRECT = "yandex_direct"
SERVICE_METRIKA = "yandex_metrika"
SERVICE_HOSTING = "hosting"
SERVICE_KINDS = (SERVICE_DIRECT, SERVICE_METRIKA, SERVICE_HOSTING)

SERVICE_TITLES = {
    SERVICE_DIRECT: "Яндекс.Директ",
    SERVICE_METRIKA: "Яндекс.Метрика",
    SERVICE_HOSTING: "Сайт и хостинг",
}


# ──────────────────────────── База и пользователь ────────────────────────────


async def get_db() -> AsyncIterator[AsyncSession]:
    """Сессия базы на время запроса."""
    async for session in db_session():
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db)]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "tma"})


async def tg_user(
    x_telegram_init_data: Annotated[str | None, Header(alias=INIT_DATA_HEADER)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> TelegramUser:
    """Проверяет подпись Telegram и возвращает пользователя.

    Без правильной подписи любой запрос к данным получает 401 — это
    требование ТЗ и главная защита приложения.
    """
    raw = x_telegram_init_data or ""
    if not raw and authorization and authorization.lower().startswith("tma "):
        raw = authorization[4:]
    try:
        return verify_init_data(raw)
    except AuthError as error:
        log.warning("Запрос без валидной подписи", reason=str(error)[:120])
        raise _unauthorized(str(error)) from error


TgUser = Annotated[TelegramUser, Depends(tg_user)]


async def current_user(user: TgUser, session: DbSession) -> User:
    """Пользователь из базы: создаётся при первом входе в приложение."""
    db_user, created = await get_or_create_user(
        session,
        user.id,
        username=user.username,
        first_name=user.first_name,
        last_name=user.last_name,
        language_code=user.language_code,
    )
    if created:
        log.info("Новый пользователь из Mini App", tg_id=user.id)
    if db_user.is_blocked:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Аккаунт заблокирован ботом")
    await session.commit()
    return db_user


CurrentUser = Annotated[User, Depends(current_user)]


# ──────────────────────────── Подключения сервисов ────────────────────────────


async def get_connection(session: AsyncSession, user: User, kind: str) -> ServiceConnection | None:
    """Активное подключение сервиса у пользователя (или None)."""
    result = await session.execute(
        select(ServiceConnection).where(
            ServiceConnection.user_id == user.id,
            ServiceConnection.service_type == kind,
        ),
    )
    return result.scalar_one_or_none()


async def require_connection(session: AsyncSession, user: User, kind: str) -> ServiceConnection:
    """Подключение, без которого действие невозможно — иначе понятная ошибка."""
    connection = await get_connection(session, user, kind)
    if connection is None or not connection.is_active:
        title = SERVICE_TITLES.get(kind, kind)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{title} не подключён — добавьте доступ на экране «Подключения»",
        )
    return connection


def decrypt_token(box: SecretBox, connection: ServiceConnection) -> str:
    """Расшифровывает токен подключения. Повреждённый токен — это 400, а не 500."""
    try:
        return box.decrypt(connection.encrypted_token)
    except Exception as error:  # noqa: BLE001 — ключ мог измениться
        log.error("Не удалось расшифровать токен", service=connection.service_type, error=str(error))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Токен подключения повреждён — подключите сервис заново",
        ) from error


async def direct_client(session: DbSession, user: CurrentUser) -> AsyncIterator[DirectClient]:
    """Клиент Яндекс.Директа на время запроса.

    Демо-подключения (их создаёт режим разработки) обслуживает клиент из памяти:
    проверить интерфейс можно без доступа к api.direct.yandex.ru.
    """
    connection = await require_connection(session, user, SERVICE_DIRECT)
    token = decrypt_token(get_secret_box(), connection)
    if is_demo_token(token, DEMO_DIRECT_TOKEN):
        demo = DemoDirectClient(token, login=str((connection.metadata_json or {}).get("login") or ""))
        try:
            yield demo
        finally:
            await demo.close()
        return
    client = await build_direct_client(
        token,
        login=str((connection.metadata_json or {}).get("login") or "") or None,
    )
    try:
        yield client
    finally:
        await client.close()


async def metrika_client(session: DbSession, user: CurrentUser) -> AsyncIterator[MetrikaClient]:
    """Клиент Яндекс.Метрики на время запроса (номер счётчика — из подключения)."""
    connection = await require_connection(session, user, SERVICE_METRIKA)
    token = decrypt_token(get_secret_box(), connection)
    counter_id = (connection.metadata_json or {}).get("counter_id")
    if is_demo_token(token, DEMO_METRIKA_TOKEN):
        demo = DemoMetrikaClient(token, counter_id=int(counter_id) if counter_id else None)
        try:
            yield demo
        finally:
            await demo.close()
        return
    client = MetrikaClient(token=token, counter_id=int(counter_id) if counter_id else None)
    try:
        yield client
    finally:
        await client.close()


DirectClientDep = Annotated[DirectClient, Depends(direct_client)]
MetrikaClientDep = Annotated[MetrikaClient, Depends(metrika_client)]


async def optional_direct_client(session: DbSession, user: CurrentUser) -> AsyncIterator[DirectClient | None]:
    """Клиент Директа, если он подключён: для экранов, которые работают и без него."""
    connection = await get_connection(session, user, SERVICE_DIRECT)
    if connection is None or not connection.is_active:
        yield None
        return
    token = decrypt_token(get_secret_box(), connection)
    if is_demo_token(token, DEMO_DIRECT_TOKEN):
        demo = DemoDirectClient(token, login=str((connection.metadata_json or {}).get("login") or ""))
        try:
            yield demo  # type: ignore[misc]
        finally:
            await demo.close()
        return
    client = DirectClient(token=token, login=str((connection.metadata_json or {}).get("login") or "") or None)
    try:
        yield client
    finally:
        await client.close()


OptionalDirectClientDep = Annotated[DirectClient | None, Depends(optional_direct_client)]


async def optional_metrika_client(session: DbSession, user: CurrentUser) -> AsyncIterator[MetrikaClient | None]:
    """Клиент Метрики, если он подключён."""
    connection = await get_connection(session, user, SERVICE_METRIKA)
    if connection is None or not connection.is_active:
        yield None
        return
    token = decrypt_token(get_secret_box(), connection)
    counter_id = (connection.metadata_json or {}).get("counter_id")
    if is_demo_token(token, DEMO_METRIKA_TOKEN):
        demo = DemoMetrikaClient(token, counter_id=int(counter_id) if counter_id else None)
        try:
            yield demo  # type: ignore[misc]
        finally:
            await demo.close()
        return
    client = MetrikaClient(token=token, counter_id=int(counter_id) if counter_id else None)
    try:
        yield client
    finally:
        await client.close()


OptionalMetrikaClientDep = Annotated[MetrikaClient | None, Depends(optional_metrika_client)]


# ──────────────────────────── Профиль, сайт, ИИ ────────────────────────────


async def profile_of(session: DbSession, user: CurrentUser) -> BusinessProfile:
    """Профиль бизнеса пользователя."""
    return await load_profile(session, user)


ProfileDep = Annotated[BusinessProfile, Depends(profile_of)]


async def site_url_of(session: DbSession, user: CurrentUser, profile: ProfileDep) -> str | None:
    """Адрес сайта: сначала из подключения хостинга, потом из профиля."""
    connection = await get_connection(session, user, SERVICE_HOSTING)
    if connection is not None:
        url = str((connection.metadata_json or {}).get("site_url") or "")
        if url:
            return url
    return profile.site_url or None


SiteUrlDep = Annotated[str | None, Depends(site_url_of)]


async def site_passport(session: DbSession, user: CurrentUser, url: str):
    """Паспорт сайта по адресу из аргумента (используется на экране подключения)."""
    try:
        target = normalize_url(url)
    except SiteError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    try:
        return await build_passport(target)
    except Exception as error:  # noqa: BLE001 — сайт клиента может ответить чем угодно
        log.warning("Не удалось собрать паспорт сайта", url=target, error=str(error))
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Сайт не ответил: {error}") from error


async def ai_client() -> AsyncIterator[OpenRouterClient]:
    """Клиент OpenRouter. Без ключа экраны работают на шаблонных текстах."""
    client = OpenRouterClient(
        api_key=settings.OPENROUTER_API_KEY,
        model=settings.AI_MODEL,
        site_url=settings.WEBAPP_URL,
    )
    try:
        yield client
    finally:
        await client.close()


AiClientDep = Annotated[OpenRouterClient, Depends(ai_client)]


__all__ = [
    "AiClientDep",
    "CurrentUser",
    "DbSession",
    "DirectClientDep",
    "MetrikaClientDep",
    "OptionalDirectClientDep",
    "OptionalMetrikaClientDep",
    "ProfileDep",
    "SERVICE_DIRECT",
    "SERVICE_HOSTING",
    "SERVICE_KINDS",
    "SERVICE_METRIKA",
    "SERVICE_TITLES",
    "SiteUrlDep",
    "TgUser",
    "current_user",
    "decrypt_token",
    "get_connection",
    "get_db",
    "require_connection",
    "site_passport",
    "tg_user",
]
