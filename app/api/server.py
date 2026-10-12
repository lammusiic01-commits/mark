"""Сборка REST API: все роуты под префиксом /api (подключается в app/main.py)."""
from fastapi import APIRouter

from app.api.routes import (
    balance, bot_shield, campaigns, competitors, dashboard, funnel, hypotheses,
    reports, roi, seo, services, settings, utils,
)

api_router = APIRouter()
for module in (
    utils, dashboard, campaigns, bot_shield, hypotheses, seo, competitors,
    roi, funnel, reports, balance, settings, services,
):
    api_router.include_router(module.router)
