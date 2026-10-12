"""Модели базы данных (SQLAlchemy 2.0, типизированный стиль).

Схема соответствует утверждённому ТЗ:
  users, service_connections, campaigns, bot_reports, hypotheses, payments.

Правила:
  • все временные метки — с таймзоной, в UTC;
  • токены сервисов хранятся только зашифрованными (поле encrypted_token);
  • удаление пользователя каскадно чистит его данные;
  • часто используемые выборки закрыты индексами.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    func,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    """Текущее время в UTC (с таймзоной, чтобы не путаться в отчётах)."""
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """Базовый класс моделей: общий набор служебных полей и методов."""

    def to_dict(self, exclude: tuple[str, ...] = ()) -> dict[str, Any]:
        """Плоское представление для отчётов и API (без секретов по умолчанию)."""
        result: dict[str, Any] = {}
        for column in self.__table__.columns:
            if column.name in exclude:
                continue
            value = getattr(self, column.name)
            if isinstance(value, datetime):
                value = value.isoformat()
            result[column.name] = value
        return result

    def __repr__(self) -> str:  # pragma: no cover — читаемость в логах
        identifier = getattr(self, "id", None)
        return f"<{self.__class__.__name__} id={identifier}>"


class TimestampMixin:
    """Метки создания и обновления — есть у каждой таблицы."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, onupdate=utcnow, nullable=False,
    )


class User(TimestampMixin, Base):
    """Пользователь бота: у каждого — свой баланс и свои подключения."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tg_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    last_name: Mapped[str | None] = mapped_column(String(128))
    language_code: Mapped[str | None] = mapped_column(String(8))
    balance: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    connections: Mapped[list["ServiceConnection"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin",
    )
    campaigns: Mapped[list["Campaign"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin",
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User tg_id={self.tg_id} @{self.username}>"


class ServiceConnection(TimestampMixin, Base):
    """Подключённый сервис: Директ, Метрика, хостинг.

    Токен лежит в encrypted_token в зашифрованном виде (Fernet). Открытый
    токен существует только в памяти процесса во время запроса к сервису.
    """

    __tablename__ = "service_connections"
    __table_args__ = (
        Index("ix_service_connections_user_type", "user_id", "service_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    service_type: Mapped[str] = mapped_column(String(32), nullable=False)  # yandex_direct | yandex_metrika | hosting
    encrypted_token: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    user: Mapped[User] = relationship(back_populates="connections")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<ServiceConnection {self.service_type} user={self.user_id} active={self.is_active}>"


class Campaign(TimestampMixin, Base):
    """Рекламная кампания и её последняя статистика (кэш)."""

    __tablename__ = "campaigns"
    __table_args__ = (
        Index("ix_campaigns_user_status", "user_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    external_id: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="draft", nullable=False)
    daily_budget: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    target_cpa: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    stats_cache: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    stats_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="campaigns")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Campaign {self.external_id} «{self.name}»>"


class BotReport(TimestampMixin, Base):
    """Отчёт детектора ботов: цифры от движка + человеческий текст от AI."""

    __tablename__ = "bot_reports"
    __table_args__ = (
        Index("ix_bot_reports_user_period", "user_id", "period_from", "period_to"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    period_from: Mapped[str] = mapped_column(String(10), nullable=False)  # YYYY-MM-DD
    period_to: Mapped[str] = mapped_column(String(10), nullable=False)
    report_data: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    ai_summary: Mapped[str | None] = mapped_column(Text)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<BotReport {self.period_from}…{self.period_to} user={self.user_id}>"


class Hypothesis(TimestampMixin, Base):
    """Гипотеза роста: считается движком, проверяется статистикой."""

    __tablename__ = "hypotheses"
    __table_args__ = (
        Index("ix_hypotheses_user_priority", "user_id", "priority"),
        Index("ix_hypotheses_user_status", "user_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_impact_pct: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    required_budget: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    duration_days: Mapped[int] = mapped_column(Integer, default=14, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Hypothesis {self.code} «{self.title}» {self.status}>"


class Payment(TimestampMixin, Base):
    """Платёж по СБП: от создания QR до зачисления на баланс."""

    __tablename__ = "payments"
    __table_args__ = (
        Index("ix_payments_user_status", "user_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    payment_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    sbp_url: Mapped[str] = mapped_column(Text, default="", nullable=False)
    qr_payload: Mapped[str | None] = mapped_column(Text)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Payment {self.payment_id} {self.amount}₽ {self.status}>"


# Таблицы в порядке создания: нужен для create_all и для alembic autogenerate
__all__ = [
    "Base",
    "BotReport",
    "Campaign",
    "Hypothesis",
    "Payment",
    "ServiceConnection",
    "User",
    "display_name",
    "get_or_create_user",
    "get_user_by_tg_id",
    "utcnow",
]


# ─── Работа с пользователем ────────────────────────────────────

async def get_or_create_user(
    session: AsyncSession,
    tg_id: int,
    *,
    username: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    language_code: str | None = None,
) -> tuple[User, bool]:
    """Возвращает пользователя и признак «создан только что».

    Бот вызывает это на /start, API — при первом запросе Mini App, поэтому
    функция живёт рядом с моделями: одна реализация, без дублирования.
    Имя и username обновляются, если пользователь поменял их в Telegram.
    """
    result = await session.execute(select(User).where(User.tg_id == tg_id))
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            tg_id=tg_id,
            username=username,
            first_name=first_name,
            last_name=last_name,
            language_code=language_code,
        )
        session.add(user)
        await session.flush()
        return user, True

    changed = False
    for field, value in (
        ("username", username),
        ("first_name", first_name),
        ("last_name", last_name),
        ("language_code", language_code),
    ):
        if value is not None and getattr(user, field) != value:
            setattr(user, field, value)
            changed = True
    if changed:
        await session.flush()

    return user, False


async def get_user_by_tg_id(session: AsyncSession, tg_id: int) -> User | None:
    """Пользователь по Telegram ID — для уведомлений и проверок доступа."""
    result = await session.execute(select(User).where(User.tg_id == tg_id))
    return result.scalar_one_or_none()


def display_name(user: User) -> str:
    """Как обращаться к пользователю в сообщениях и интерфейсе."""
    if user.first_name:
        return user.first_name
    if user.username:
        return f"@{user.username}"
    return f"id{user.tg_id}"
