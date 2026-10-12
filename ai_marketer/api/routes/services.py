"""Подключение сервисов: Директ, Метрика и сайт клиента.

Правила, которые здесь соблюдаются:
  • токен проверяется живым запросом до сохранения — иначе пользователь
    узнает о неверном ключе только через сутки, когда отчёт не придёт;
  • в базе токен лежит только зашифрованным (Fernet, ключ из secrets.env);
  • наружу никогда не отдаётся полный токен — только маска вида «y0_Ag•••»;
  • сайт можно проверить до подключения: экран показывает паспорт сайта.

Подключение к сайту не зависит от платформы: Tilda, WordPress, Vercel или
самописный проект — работаем с обычным HTTP-ответом и кодом страницы.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from api.deps import (
    SERVICE_DIRECT,
    SERVICE_HOSTING,
    SERVICE_KINDS,
    SERVICE_METRIKA,
    SERVICE_TITLES,
    CurrentUser,
    DbSession,
    decrypt_token,
    get_connection,
)
from core.logger import get_logger
from core.models import ServiceConnection
from core.security import SecretBox, get_secret_box, mask_secret
from services.hosting import SiteError, build_passport, domain_of, guess_platform_hint, normalize_url
from services.yandex_direct import DirectClient, DirectError, build_client as build_direct_client
from services.yandex_metrika import MetrikaClient, MetrikaError

log = get_logger(__name__)

router = APIRouter(prefix="/services", tags=["подключения"])


class ConnectRequest(BaseModel):
    """Данные для подключения сервиса: заполняется только нужное поле."""

    token: str = Field(default="", description="Токен сервиса (Директ или Метрика)")
    counter_id: int | None = Field(default=None, description="Номер счётчика Метрики")
    site_url: str = Field(default="", description="Адрес сайта для проверки")
    login: str = Field(default="", description="Логин аккаунта Директа (для агентских)")


def _service_title(kind: str) -> str:
    return SERVICE_TITLES.get(kind, kind)


def _connection_view(connection: ServiceConnection | None, kind: str) -> dict[str, Any]:
    """Как подключение выглядит в интерфейсе: без секретов."""
    if connection is None:
        return {
            "kind": kind,
            "title": _service_title(kind),
            "connected": False,
            "is_active": False,
            "checked_at": None,
            "last_error": None,
            "details": {},
        }

    meta = dict(connection.metadata_json or {})
    details: dict[str, Any] = {}
    if kind == SERVICE_DIRECT:
        details = {
            "login": meta.get("login") or "",
            "campaigns": meta.get("campaigns"),
            "token_masked": meta.get("token_masked") or "",
        }
    elif kind == SERVICE_METRIKA:
        details = {
            "counter_id": meta.get("counter_id"),
            "counter_name": meta.get("counter_name") or "",
            "goals": meta.get("goals"),
            "token_masked": meta.get("token_masked") or "",
        }
    elif kind == SERVICE_HOSTING:
        details = {
            "site_url": meta.get("site_url") or "",
            "platform": meta.get("platform") or "",
            "hosting": meta.get("hosting") or "",
            "https": meta.get("https"),
            "has_metrika": meta.get("has_metrika"),
        }

    return {
        "kind": kind,
        "title": _service_title(kind),
        # «Подключён» — только если доступ действительно работает: отключённый
        # сервис с сохранёнными настройками не должен выглядеть живым
        "connected": bool(connection.is_active),
        "is_active": bool(connection.is_active),
        "checked_at": connection.last_checked_at.isoformat() if connection.last_checked_at else None,
        "last_error": connection.last_error,
        "details": details,
    }


async def _save_connection(
    session: DbSession,
    user: CurrentUser,
    kind: str,
    *,
    token: str = "",
    metadata: dict[str, Any] | None = None,
    box: SecretBox | None = None,
) -> ServiceConnection:
    """Сохраняет подключение: токен шифруется, метаданные кладутся как есть."""
    secret_box = box or get_secret_box()
    connection = await get_connection(session, user, kind)
    encrypted = secret_box.encrypt(token) if token else ""

    if connection is None:
        connection = ServiceConnection(
            user_id=user.id,
            service_type=kind,
            encrypted_token=encrypted,
            metadata_json=metadata or {},
            is_active=True,
        )
        session.add(connection)
    else:
        if encrypted:
            connection.encrypted_token = encrypted
        connection.metadata_json = {**(connection.metadata_json or {}), **(metadata or {})}
        connection.is_active = True

    connection.last_checked_at = datetime.now(timezone.utc)
    connection.last_error = None
    await session.flush()
    return connection


@router.get("", summary="Список подключений")
async def list_services(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Все три сервиса с их состоянием — для экрана «Подключения»."""
    result = await session.execute(
        select(ServiceConnection).where(
            ServiceConnection.user_id == user.id,
            ServiceConnection.service_type.in_(SERVICE_KINDS),
        ),
    )
    rows = {row.service_type: row for row in result.scalars().all()}
    services = [_connection_view(rows.get(kind), kind) for kind in SERVICE_KINDS]
    connected = sum(1 for service in services if service["connected"] and service["is_active"])
    return {
        "services": services,
        "connected_count": connected,
        "total": len(SERVICE_KINDS),
        "ready": connected >= 2,  # для расчётов нужны минимум Директ и Метрика
    }


@router.get("/site/passport", summary="Паспорт сайта до подключения")
async def site_passport(url: str, user: CurrentUser) -> dict[str, Any]:
    """Что мы поняли про сайт: платформа, хостинг, HTTPS, счётчик, карта сайта.

    Вызывается из BottomSheet при вводе адреса — до сохранения, чтобы человек
    сразу увидел результат проверки.
    """
    try:
        target = normalize_url(url)
    except SiteError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    try:
        passport = await build_passport(target)
    except Exception as error:  # noqa: BLE001 — сайт может ответить чем угодно
        log.warning("Паспорт сайта не собрался", url=target, error=str(error))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Не удалось проверить сайт: {error}",
        ) from error

    data = passport.to_dict()
    data["hint"] = guess_platform_hint(passport.platform)
    data["domain"] = domain_of(target)
    return data


@router.post("/{kind}/connect", summary="Подключить сервис")
async def connect_service(
    kind: str,
    payload: ConnectRequest,
    session: DbSession,
    user: CurrentUser,
) -> dict[str, Any]:
    """Проверяет доступ и сохраняет подключение (токен — только в шифре)."""
    if kind not in SERVICE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Неизвестный сервис: {kind}")

    box = get_secret_box()

    if kind == SERVICE_DIRECT:
        token = payload.token.strip()
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Вставьте OAuth-токен Яндекс.Директа")
        client = await build_direct_client(token, login=payload.login.strip() or None)
        try:
            state = await client.check_token()
        except DirectError as error:
            log.warning("Директ не принял токен", reason=str(error)[:160])
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
        finally:
            await client.close()

        connection = await _save_connection(
            session,
            user,
            kind,
            token=token,
            metadata={
                "login": payload.login.strip(),
                "campaigns": state.get("campaigns", 0),
                "currency": state.get("currency", "RUB"),
                "token_masked": mask_secret(token),
                "connected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
            box=box,
        )
        await session.commit()
        log.info("Директ подключён", user_id=user.id, campaigns=state.get("campaigns"))
        return {
            "ok": True,
            "service": _connection_view(connection, kind),
            "message": f"Директ подключён: доступно кампаний — {state.get('campaigns', 0)}",
        }

    if kind == SERVICE_METRIKA:
        token = payload.token.strip()
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Вставьте OAuth-токен Яндекс.Метрики")
        client = MetrikaClient(token=token, counter_id=payload.counter_id)
        try:
            counters = await client.list_counters()
            if not counters:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="У этого токена нет доступных счётчиков Метрики — проверьте права доступа",
                )
            counter_id = payload.counter_id or int(counters[0]["id"])
            chosen = next((item for item in counters if int(item["id"]) == counter_id), counters[0])
            client.counter_id = counter_id
            goals = await client.list_goals(counter_id)
        except MetrikaError as error:
            log.warning("Метрика не приняла токен", reason=str(error)[:160])
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
        finally:
            await client.close()

        connection = await _save_connection(
            session,
            user,
            kind,
            token=token,
            metadata={
                "counter_id": counter_id,
                "counter_name": chosen.get("name") or f"Счётчик {counter_id}",
                "site": chosen.get("site") or "",
                "goals": len(goals),
                "counters_total": len(counters),
                "token_masked": mask_secret(token),
                "connected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
            box=box,
        )
        await session.commit()
        log.info("Метрика подключена", user_id=user.id, counter_id=counter_id, goals=len(goals))
        return {
            "ok": True,
            "service": _connection_view(connection, kind),
            "message": f"Метрика подключена: счётчик «{chosen.get('name')}», целей — {len(goals)}",
        }

    # Остался сайт: токен не нужен, проверяем доступность и собираем паспорт
    url = payload.site_url.strip()
    if not url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите адрес сайта")
    try:
        target = normalize_url(url)
        passport = await build_passport(target)
    except SiteError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    if not passport.ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=passport.error or "Сайт не отвечает — проверьте адрес",
        )

    connection = await _save_connection(
        session,
        user,
        kind,
        metadata={
            "site_url": passport.url,
            "domain": passport.domain,
            "platform": passport.platform,
            "platform_title": passport.platform_title,
            "hosting": passport.hosting,
            "https": passport.https,
            "has_metrika": passport.has_metrika,
            "has_sitemap": passport.has_sitemap,
            "response_ms": passport.response_ms,
            "notes": passport.notes,
            "connected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        box=box,
    )
    await session.commit()
    log.info("Сайт подключён", user_id=user.id, domain=passport.domain, platform=passport.platform)
    return {
        "ok": True,
        "service": _connection_view(connection, kind),
        "passport": passport.to_dict(),
        "hint": guess_platform_hint(passport.platform),
        "message": f"Сайт {passport.domain} подключён: платформа — {passport.platform}",
    }


@router.post("/{kind}/check", summary="Проверить подключение")
async def check_service(kind: str, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Повторно проверяет доступ — например, после смены пароля в Яндексе."""
    if kind not in SERVICE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Неизвестный сервис: {kind}")

    connection = await get_connection(session, user, kind)
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{_service_title(kind)} ещё не подключён")

    ok = True
    message = "Подключение работает"
    details: dict[str, Any] = {}

    try:
        if kind == SERVICE_DIRECT:
            client = await build_direct_client(
                decrypt_token(get_secret_box(), connection),
                login=str((connection.metadata_json or {}).get("login") or "") or None,
            )
            try:
                state = await client.check_token()
            finally:
                await client.close()
            details = {"campaigns": state.get("campaigns", 0), "currency": state.get("currency")}
            message = f"Директ на связи: кампаний — {state.get('campaigns', 0)}"

        elif kind == SERVICE_METRIKA:
            counter_id = (connection.metadata_json or {}).get("counter_id")
            client = MetrikaClient(
                token=decrypt_token(get_secret_box(), connection),
                counter_id=int(counter_id) if counter_id else None,
            )
            try:
                goals = await client.list_goals()
            finally:
                await client.close()
            details = {"goals": len(goals)}
            message = f"Метрика на связи: целей — {len(goals)}"

        else:
            site_url = str((connection.metadata_json or {}).get("site_url") or "")
            passport = await build_passport(site_url)
            details = passport.to_dict()
            message = f"Сайт отвечает: код {passport.status_code}, платформа — {passport.platform}"
            ok = passport.ok
    except (DirectError, MetrikaError, SiteError) as error:
        ok = False
        message = str(error)
        connection.last_error = str(error)[:500]
        log.warning("Проверка подключения не прошла", service=kind, reason=str(error)[:160])
    except Exception as error:  # noqa: BLE001 — сеть, DNS, чужие ответы
        ok = False
        message = f"Не удалось проверить: {error}"
        connection.last_error = message[:500]

    connection.is_active = ok
    connection.last_checked_at = datetime.now(timezone.utc)
    if ok:
        connection.last_error = None
    await session.commit()

    return {"ok": ok, "message": message, "service": _connection_view(connection, kind), "details": details}


@router.delete("/{kind}", summary="Отключить сервис")
async def disconnect_service(kind: str, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Отключает сервис: токен стирается, история отчётов остаётся."""
    if kind not in SERVICE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Неизвестный сервис: {kind}")

    connection = await get_connection(session, user, kind)
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{_service_title(kind)} ещё не подключён")

    connection.is_active = False
    connection.encrypted_token = ""
    metadata = dict(connection.metadata_json or {})
    metadata.pop("token_masked", None)
    connection.metadata_json = metadata
    await session.commit()

    log.info("Сервис отключён", user_id=user.id, service=kind)
    return {
        "ok": True,
        "message": f"{_service_title(kind)} отключён",
        "service": _connection_view(connection, kind),
    }


@router.get("/{kind}", summary="Одно подключение")
async def get_service(kind: str, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Состояние конкретного сервиса."""
    if kind not in SERVICE_KINDS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Неизвестный сервис: {kind}")
    connection = await get_connection(session, user, kind)
    return {"service": _connection_view(connection, kind)}


__all__ = ["router"]
