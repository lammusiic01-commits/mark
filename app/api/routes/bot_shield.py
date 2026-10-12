"""Bot Shield: анализ кампаний на накрутку и ботовый трафик."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_session
from app.engine import bot_detector
from app.engine import campaign_manager as cm
from app.models import User

router = APIRouter(prefix="/bot-shield", tags=["bot-shield"])


@router.get("")
async def bot_shield(days: int = 14, user: User = Depends(get_current_user),
                     session: AsyncSession = Depends(get_session)) -> dict:
    date_from, date_to = cm.days_window(days)
    rows = await cm.load_window(session, user.id, date_from, date_to)
    result = bot_detector.analyze(cm.group_campaigns(rows))
    result["period"] = {"from": date_from.isoformat(), "to": date_to.isoformat()}
    result["checked_campaigns"] = len(result["items"])
    return result
