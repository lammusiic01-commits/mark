"""ROI-калькулятор и подсказки по значениям из реальных кампаний."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import campaign_manager as cm
from app.engine import roi_calculator
from app.models import User

router = APIRouter(prefix="/roi", tags=["roi"])


class RoiIn(BaseModel):
    budget_rub: float = Field(ge=0, le=1e9)
    cpc_rub: float = Field(gt=0, le=1e6)
    cr_percent: float = Field(ge=0, le=100)
    avg_check_rub: float = Field(ge=0, le=1e9)
    margin_percent: float = Field(ge=0, le=100)


@router.post("/calc")
async def calc(body: RoiIn, user: User = Depends(get_current_user)) -> dict:
    try:
        return roi_calculator.calculate(body.budget_rub, body.cpc_rub, body.cr_percent,
                                        body.avg_check_rub, body.margin_percent)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/defaults")
async def defaults(days: int = 14, user: User = Depends(get_current_user),
                   session: AsyncSession = Depends(get_session)) -> dict:
    """Средние CPC и CR за период — стартовые значения для калькулятора."""
    date_from, date_to = cm.days_window(days)
    s = cm.summarize(await cm.load_window(session, user.id, date_from, date_to))
    return {
        "cpc_rub": round(s["cpc_kop"] / 100, 2),
        "cr_percent": s["cr"],
        "budget_rub": round(user.daily_budget_kop / 100, 2),
        "has_data": s["clicks"] > 0,
    }
