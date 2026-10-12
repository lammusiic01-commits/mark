"""ORM-модели (SQLAlchemy 2.0)."""
from datetime import date, datetime, timezone

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tg_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    first_name: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    ai_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    balance_kop: Mapped[int] = mapped_column(Integer, default=0)

    site_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    metrika_counter_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # ID цели Метрики, по которой Директ считает конверсии (поле Conversions)
    metrika_goal_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    target_cpa_kop: Mapped[int] = mapped_column(Integer, default=0)
    daily_budget_kop: Mapped[int] = mapped_column(Integer, default=0)

    # Секреты храним только в зашифрованном виде (Fernet, security.py)
    yandex_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    openrouter_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Campaign(Base):
    __tablename__ = "campaigns"
    __table_args__ = (UniqueConstraint("user_id", "external_id", name="uq_campaign_user_ext"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    external_id: Mapped[int] = mapped_column(BigInteger)
    name: Mapped[str] = mapped_column(String(256), default="")
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")
    daily_budget_kop: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class DailyStat(Base):
    __tablename__ = "daily_stats"
    __table_args__ = (UniqueConstraint("campaign_id", "date", name="uq_stat_campaign_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    cost_kop: Mapped[int] = mapped_column(Integer, default=0)
    conversions: Mapped[int] = mapped_column(Integer, default=0)


class SiteStat(Base):
    """Посещения сайта по дням (Яндекс Метрика)."""

    __tablename__ = "site_stats"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_site_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    visits: Mapped[int] = mapped_column(Integer, default=0)
    users: Mapped[int] = mapped_column(Integer, default=0)
    bounce_rate: Mapped[float] = mapped_column(Float, default=0.0)


class Hypothesis(Base):
    __tablename__ = "hypotheses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    a_visitors: Mapped[int] = mapped_column(Integer, default=0)
    a_conversions: Mapped[int] = mapped_column(Integer, default=0)
    b_visitors: Mapped[int] = mapped_column(Integer, default=0)
    b_conversions: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Competitor(Base):
    __tablename__ = "competitors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    url: Mapped[str] = mapped_column(String(512))
    last_title: Mapped[str] = mapped_column(String(512), default="")
    last_status: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    changed: Mapped[bool] = mapped_column(Boolean, default=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SeoCheck(Base):
    __tablename__ = "seo_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(512))
    score: Mapped[int] = mapped_column(Integer, default=0)
    issues_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    days: Mapped[int] = mapped_column(Integer, default=14)
    body_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Transaction(Base):
    """Пополнения баланса (kind=topup) и списания за AI (kind=ai)."""

    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    amount_kop: Mapped[int] = mapped_column(Integer)  # >0 пополнение, <0 списание
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|paid
    comment: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
