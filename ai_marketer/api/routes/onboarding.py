"""Первый вход: приветствие, выбор ниши и региона, завершение настройки.

Онбординг состоит из пяти шагов (как в утверждённом дизайне):
  1. приветствие с орбом;
  2. рассказ о четырёх возможностях;
  3. подсказки «где взять ключ»;
  4. безопасность данных;
  5. готово → экран подключения.

Сервер здесь решает две задачи: отдаёт список ниш и регионов для выбора и
запоминает, что человек прошёл настройку. Шаги между собой переключает
приложение — сервер не должен знать, на каком экране открыт телефон.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from api.deps import CurrentUser, DbSession, ProfileDep
from api.profile import profile_completeness, save_profile
from core.logger import get_logger
from engine.geo_analyzer import REGION_NAMES
from engine.market_analyzer import NICHE_BENCHMARKS, niches_catalog

log = get_logger(__name__)

router = APIRouter(prefix="/onboarding", tags=["первый вход"])

# Популярные регионы первыми: по ним чаще всего работают
POPULAR_REGIONS = [213, 1, 2, 54, 43, 65, 172, 35, 239, 47, 51, 56]

# Тексты шагов — приходят с сервера, чтобы их можно было править без
# пересборки приложения
STEPS: list[dict[str, Any]] = [
    {
        "key": "welcome",
        "title": "Ваш маркетолог на связи",
        "subtitle": "Слежу за рекламой, нахожу утечки бюджета и предлагаю решения",
        "cta": "Начать",
    },
    {
        "key": "features",
        "title": "Что я умею",
        "subtitle": "Четыре вещи, которые обычно отнимают время у бизнеса",
        "cta": "Дальше",
        "features": [
            {"icon": "🤖", "title": "Ловлю ботов", "text": "Нахожу накрутку кликов и возвращаю деньги"},
            {"icon": "📊", "title": "Считаю экономику", "text": "Цена заявки, бюджет и окупаемость — на одном экране"},
            {"icon": "💡", "title": "Предлагаю гипотезы", "text": "Что изменить в кампаниях, с расчётом эффекта"},
            {"icon": "⚡", "title": "Меняю ставки", "text": "Сам подстраиваю ставки под целевую заявку"},
        ],
    },
    {
        "key": "keys",
        "title": "Нужны два ключа",
        "subtitle": "Всё делается в кабинете Яндекса за пару минут",
        "cta": "Дальше",
        "accordions": [
            {
                "title": "Где взять токен Яндекс.Директа?",
                "steps": [
                    "Откройте direct.yandex.ru → «Инструменты» → «Настройки API»",
                    "Нажмите «Получить токен» — войдите тем аккаунтом, где реклама",
                    "Скопируйте OAuth-токен и вставьте его на следующем экране",
                ],
            },
            {
                "title": "Где взять токен Яндекс.Метрики?",
                "steps": [
                    "Откройте metrika.yandex.ru → «Настройка» → «Доступ к API»",
                    "Нажмите «Получить токен» и скопируйте его",
                    "Номер счётчика виден там же — в списке счётчиков",
                ],
            },
            {
                "title": "Где взять данные сайта?",
                "steps": [
                    "Ничего получать не нужно — просто пришлите адрес сайта",
                    "Подойдёт Tilda, WordPress, свой сайт или лендинг на любой платформе",
                    "Если сайта нет, продолжайте без него: реклама и метрика работают отдельно",
                ],
            },
        ],
    },
    {
        "key": "security",
        "title": "Данные под защитой",
        "subtitle": "Три правила, по которым работает сервис",
        "cta": "Дальше",
        "cards": [
            {"icon": "🔒", "title": "Токены зашифрованы", "text": "Хранятся в зашифрованном виде и не покидают сервер"},
            {"icon": "🙈", "title": "Пароли не нужны", "text": "Работаем по официальным токенам, доступ можно отозвать в любой момент"},
            {"icon": "↩️", "title": "Контроль у вас", "text": "Все изменения видны, их можно отменить одной кнопкой"},
        ],
    },
    {
        "key": "ready",
        "title": "Всё готово",
        "subtitle": "Подключим Директ и Метрику — и я начну считать",
        "cta": "Подключить сервисы",
    },
]


class NicheRequest(BaseModel):
    """Выбор ниши и региона для ориентиров рынка."""

    niche: str = Field(default="", description="Ключ ниши из списка")
    region_code: int = Field(default=213, ge=0, description="Код региона Яндекса")
    monthly_budget_rub: float = Field(default=0.0, ge=0, description="Бюджет на рекламу в месяц")
    target_cpa_rub: float = Field(default=0.0, ge=0, description="Сколько готовы платить за заявку")
    site_url: str = Field(default="", description="Адрес сайта, если есть")


class ProgressRequest(BaseModel):
    """Отметка о шаге онбординга."""

    step: str = Field(default="", description="Ключ шага: welcome, features, keys, security, ready")
    completed: bool = Field(default=False, description="Пройдена ли настройка целиком")


def _niches() -> list[dict[str, Any]]:
    """Ниши из движка: с конкуренцией и ориентиром цены клика.

    Справочник живёт в движке (engine/market_analyzer.py) — здесь только
    форма ответа, чтобы приложение показало выбор с подсказками.
    """
    return [
        {
            "key": item["code"],
            "title": item["name"],
            "competition": item["competition"],
            "cpc_from_rub": item["cpc_range_rub"][0],
            "cpc_to_rub": item["cpc_range_rub"][1],
            "hint": f"клик примерно {item['cpc_range_rub'][0]}–{item['cpc_range_rub'][1]} ₽",
        }
        for item in niches_catalog()
    ]


def _region_view(code: int) -> dict[str, Any]:
    """Регион для списка выбора."""
    return {
        "code": code,
        "name": REGION_NAMES.get(code) or REGION_NAMES.get(str(code)) or f"Регион {code}",
        "popular": code in POPULAR_REGIONS,
    }


@router.get("", summary="Состояние первого входа")
async def onboarding_state(session: DbSession, user: CurrentUser, profile: ProfileDep) -> dict[str, Any]:
    """Шаги, ниши, регионы и то, что уже заполнено."""
    progress = await profile_completeness(session, user)
    return {
        "steps": STEPS,
        "total_steps": len(STEPS),
        "completed": user.onboarding_completed,
        "profile": profile.to_dict(),
        "progress": progress,
        "niches": _niches(),
        "regions": [_region_view(code) for code in POPULAR_REGIONS]
        + [_region_view(code) for code in REGION_NAMES.keys() if isinstance(code, int) and code not in POPULAR_REGIONS],
        "ready_for_connect": progress["done"] >= 2,
    }


@router.get("/niches", summary="Список ниш")
async def niches() -> dict[str, Any]:
    """Ниши для рыночных ориентиров — используется и в настройках."""
    return {
        "niches": _niches(),
    }


@router.get("/regions", summary="Список регионов")
async def regions(query: str = "") -> dict[str, Any]:
    """Регионы с поиском по названию: в списке Яндекса их больше сотни."""
    needle = query.strip().lower()
    items = [
        _region_view(code)
        for code in REGION_NAMES.keys()
        if isinstance(code, int) and (not needle or needle in str(REGION_NAMES.get(code, "")).lower())
    ]
    items.sort(key=lambda item: (not item["popular"], item["name"]))
    return {"regions": items, "count": len(items)}


@router.post("/profile", summary="Сохранить нишу, регион и цифры")
async def save_business_profile(payload: NicheRequest, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Записывает ответы пользователя — на них строятся все расчёты движка."""
    if payload.niche and payload.niche not in NICHE_BENCHMARKS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Неизвестная ниша — выберите из списка",
        )

    updates: dict[str, Any] = {
        "niche": payload.niche,
        "region_code": payload.region_code,
        "monthly_budget_rub": payload.monthly_budget_rub,
        "target_cpa_rub": payload.target_cpa_rub,
        "site_url": payload.site_url.strip(),
        "updated_from": "onboarding",
    }
    if payload.niche:
        updates["niche_title"] = NICHE_BENCHMARKS.get(payload.niche, {}).get("name") or payload.niche
    updates["region_name"] = REGION_NAMES.get(payload.region_code) or REGION_NAMES.get(str(payload.region_code)) or ""

    profile = await save_profile(session, user, updates)
    await session.commit()

    log.info(
        "Профиль из онбординга сохранён",
        user_id=user.id,
        niche=payload.niche or "не выбрана",
        region=payload.region_code,
    )
    return {
        "ok": True,
        "message": "Параметры сохранены",
        "profile": profile.to_dict(),
        "progress": await profile_completeness(session, user),
    }


@router.post("/progress", summary="Отметить пройденный шаг")
async def save_progress(payload: ProgressRequest, session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Отмечает шаг онбординга и завершает настройку, когда дошло до «ready»."""
    if payload.completed:
        user.onboarding_completed = True
        await session.commit()
        log.info("Онбординг завершён", user_id=user.id)

    return {
        "ok": True,
        "step": payload.step,
        "completed": user.onboarding_completed,
        "next": "/connect" if payload.step in {"ready", "security"} else f"/onboarding/{payload.step or 'welcome'}",
    }


@router.post("/complete", summary="Завершить настройку")
async def complete(session: DbSession, user: CurrentUser) -> dict[str, Any]:
    """Закрывает онбординг: повторно он не показывается."""
    user.onboarding_completed = True
    await session.commit()
    log.info("Первый вход завершён", user_id=user.id)
    return {"ok": True, "completed": True, "message": "Настройка завершена", "next": "/dashboard"}


__all__ = ["STEPS", "router"]
