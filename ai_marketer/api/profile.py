"""Профиль бизнеса: ниша, регионы, бюджет и целевая цена заявки.

Набор таблиц в проекте фиксирован (users, service_connections, campaigns,
bot_reports, hypotheses, payments), поэтому профиль хранится в таблице
подключений с типом «profile»: там уже есть JSON-поле для настроек,
и схему менять не нужно. Из списка сервисов такие записи исключаются —
их видит только раздел настроек и расчёты.

Что внутри профиля:
  niche         — ниша для рыночных ориентиров (ключ из market_analyzer)
  niche_title   — как ниша называется для человека
  region_code   — код региона Яндекса (213 — Москва)
  monthly_budget_rub — сколько планируется тратить на рекламу в месяц
  target_cpa_rub     — сколько владелец готов платить за одну заявку
  site_url      — адрес сайта для проверки
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.logger import get_logger
from core.models import ServiceConnection, User

log = get_logger(__name__)

PROFILE_SERVICE = "profile"

DEFAULT_PROFILE: dict[str, Any] = {
    "niche": "",
    "niche_title": "",
    "region_code": 213,
    "region_name": "Москва",
    "monthly_budget_rub": 0.0,
    "target_cpa_rub": 0.0,
    "site_url": "",
    "updated_from": "webapp",
}


@dataclass(slots=True)
class BusinessProfile:
    """Настройки бизнеса, которые влияют на расчёты движка."""

    niche: str = ""
    niche_title: str = ""
    region_code: int = 213
    region_name: str = "Москва"
    monthly_budget_rub: float = 0.0
    target_cpa_rub: float = 0.0
    site_url: str = ""
    updated_from: str = "webapp"
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def can_estimate(self) -> bool:
        """Достаточно ли данных для рыночных расчётов."""
        return bool(self.niche)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["can_estimate"] = self.can_estimate
        return payload

    @classmethod
    def from_row(cls, data: dict[str, Any] | None) -> "BusinessProfile":
        """Собирает профиль из JSON, терпимо к отсутствующим полям."""
        source = {**DEFAULT_PROFILE, **(data or {})}
        known = {
            "niche", "niche_title", "region_code", "region_name",
            "monthly_budget_rub", "target_cpa_rub", "site_url", "updated_from",
        }
        extra = {key: value for key, value in source.items() if key not in known}
        return cls(
            niche=str(source.get("niche") or ""),
            niche_title=str(source.get("niche_title") or ""),
            region_code=int(source.get("region_code") or 213),
            region_name=str(source.get("region_name") or "Москва"),
            monthly_budget_rub=float(source.get("monthly_budget_rub") or 0.0),
            target_cpa_rub=float(source.get("target_cpa_rub") or 0.0),
            site_url=str(source.get("site_url") or ""),
            updated_from=str(source.get("updated_from") or "webapp"),
            extra=extra,
        )


async def _profile_row(session: AsyncSession, user: User) -> ServiceConnection | None:
    """Строка профиля в таблице подключений (если уже создана)."""
    result = await session.execute(
        select(ServiceConnection).where(
            ServiceConnection.user_id == user.id,
            ServiceConnection.service_type == PROFILE_SERVICE,
        ),
    )
    return result.scalar_one_or_none()


async def load_profile(session: AsyncSession, user: User) -> BusinessProfile:
    """Читает профиль бизнеса. Если его ещё нет — возвращает значения по умолчанию."""
    row = await _profile_row(session, user)
    if row is None:
        return BusinessProfile()
    return BusinessProfile.from_row(dict(row.metadata_json or {}))


async def save_profile(session: AsyncSession, user: User, updates: dict[str, Any]) -> BusinessProfile:
    """Обновляет профиль: частичные изменения сохраняются поверх текущих.

    Пустой список полей означает «ничего не меняем» — так интерфейс может
    отправлять только то, что реально отредактировал пользователь.
    """
    current = await load_profile(session, user)
    data = current.to_dict()
    data.update({key: value for key, value in updates.items() if value is not None})
    data.pop("can_estimate", None)

    profile = BusinessProfile.from_row(data)
    row = await _profile_row(session, user)

    if row is None:
        row = ServiceConnection(
            user_id=user.id,
            service_type=PROFILE_SERVICE,
            encrypted_token="",  # у профиля нет секретов: здесь только настройки
            metadata_json=profile.to_dict(),
            is_active=True,
        )
        session.add(row)
    else:
        row.metadata_json = profile.to_dict()
        row.is_active = True

    await session.flush()
    log.info(
        "Профиль бизнеса сохранён",
        user_id=user.id,
        niche=profile.niche or "не указана",
        region=profile.region_code,
        budget=profile.monthly_budget_rub,
    )
    return profile


async def profile_completeness(session: AsyncSession, user: User) -> dict[str, Any]:
    """Что уже заполнено, а что нет — для экрана онбординга и настроек."""
    profile = await load_profile(session, user)
    steps = {
        "niche": bool(profile.niche),
        "region": bool(profile.region_code),
        "budget": profile.monthly_budget_rub > 0,
        "target_cpa": profile.target_cpa_rub > 0,
        "site": bool(profile.site_url),
    }
    done = sum(1 for value in steps.values() if value)
    return {
        "steps": steps,
        "done": done,
        "total": len(steps),
        "percent": round(done / len(steps) * 100),
        "onboarding_completed": user.onboarding_completed,
    }


__all__ = [
    "DEFAULT_PROFILE",
    "PROFILE_SERVICE",
    "BusinessProfile",
    "load_profile",
    "profile_completeness",
    "save_profile",
]
