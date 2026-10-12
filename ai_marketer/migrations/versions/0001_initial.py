"""Начальная схема: пользователи, подключения, кампании, отчёты, гипотезы, платежи

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ─── Пользователи ──────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tg_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("first_name", sa.String(length=128), nullable=True),
        sa.Column("last_name", sa.String(length=128), nullable=True),
        sa.Column("language_code", sa.String(length=8), nullable=True),
        sa.Column("balance", sa.Float(), nullable=False, server_default="0"),
        sa.Column("onboarding_completed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_blocked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_tg_id", "users", ["tg_id"], unique=True)

    # ─── Подключения к сервисам ─────────────────────────────────
    op.create_table(
        "service_connections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("service_type", sa.String(length=32), nullable=False),
        sa.Column("encrypted_token", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_service_connections_user_id", "service_connections", ["user_id"])
    op.create_index("ix_service_connections_user_type", "service_connections", ["user_id", "service_type"])

    # ─── Кампании ──────────────────────────────────────────────
    op.create_table(
        "campaigns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("external_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="draft"),
        sa.Column("daily_budget", sa.Float(), nullable=False, server_default="0"),
        sa.Column("target_cpa", sa.Float(), nullable=False, server_default="0"),
        sa.Column("stats_cache", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("stats_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_campaigns_user_id", "campaigns", ["user_id"])
    op.create_index("ix_campaigns_user_status", "campaigns", ["user_id", "status"])
    op.create_index("ix_campaigns_external_id", "campaigns", ["external_id"])

    # ─── Отчёты по ботам ───────────────────────────────────────
    op.create_table(
        "bot_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_from", sa.String(length=10), nullable=False),
        sa.Column("period_to", sa.String(length=10), nullable=False),
        sa.Column("report_data", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("ai_summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_bot_reports_user_id", "bot_reports", ["user_id"])
    op.create_index("ix_bot_reports_user_period", "bot_reports", ["user_id", "period_from", "period_to"])

    # ─── Гипотезы ──────────────────────────────────────────────
    op.create_table(
        "hypotheses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("expected_impact_pct", sa.Float(), nullable=False, server_default="0"),
        sa.Column("required_budget", sa.Float(), nullable=False, server_default="0"),
        sa.Column("duration_days", sa.Integer(), nullable=False, server_default="14"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("result", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_hypotheses_user_id", "hypotheses", ["user_id"])
    op.create_index("ix_hypotheses_user_priority", "hypotheses", ["user_id", "priority"])
    op.create_index("ix_hypotheses_user_status", "hypotheses", ["user_id", "status"])

    # ─── Платежи ───────────────────────────────────────────────
    op.create_table(
        "payments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("payment_id", sa.String(length=64), nullable=False),
        sa.Column("amount", sa.Float(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("sbp_url", sa.Text(), nullable=False, server_default=""),
        sa.Column("qr_payload", sa.Text(), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_payments_user_id", "payments", ["user_id"])
    op.create_index("ix_payments_user_status", "payments", ["user_id", "status"])
    op.create_index("ix_payments_payment_id", "payments", ["payment_id"], unique=True)


def downgrade() -> None:
    op.drop_table("payments")
    op.drop_table("hypotheses")
    op.drop_table("bot_reports")
    op.drop_table("campaigns")
    op.drop_table("service_connections")
    op.drop_table("users")
