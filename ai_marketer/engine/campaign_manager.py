"""Управление кампаниями: синхронизация с Директом и применение изменений.

Этот модуль — «руки» движка: он превращает решения (ставки, бюджеты, статусы)
в вызовы Яндекс.Директа и приводит локальную базу в порядок. Сам он решений
не принимает: числа приходят из bid_optimizer и budget_allocator.

Почему так: решения должны быть воспроизводимыми и объяснимыми. Если бы
управление кампаниями «решало само», проверить логику было бы нельзя.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.logger import get_logger
from core.models import Campaign, User
from engine import SEVERITY_INFO, SEVERITY_WARNING, Finding, from_micro, money, safe_div, to_float
from engine.bid_optimizer import BidPlan
from engine.budget_allocator import AllocationPlan

log = get_logger(__name__)

# Статусы кампаний, к которым приводит синхронизация
STATUS_ACTIVE = "active"
STATUS_PAUSED = "paused"
STATUS_DRAFT = "draft"
STATUS_ARCHIVED = "archived"

# Как статусы Директа переводятся в наши
DIRECT_STATUS_MAP = {
    "ACCEPTED": STATUS_ACTIVE,
    "RUNNING": STATUS_ACTIVE,
    "MODERATION": STATUS_DRAFT,
    "DRAFT": STATUS_DRAFT,
    "PREACCEPTED": STATUS_DRAFT,
    "REJECTED": STATUS_ARCHIVED,
    "SUSPENDED": STATUS_PAUSED,
    "ENDED": STATUS_PAUSED,
    "ARCHIVED": STATUS_ARCHIVED,
}

# State в Директе: включена кампания или выключена
DIRECT_STATE_MAP = {
    "ON": STATUS_ACTIVE,
    "STARTED": STATUS_ACTIVE,
    "OFF": STATUS_PAUSED,
    "SUSPENDED": STATUS_PAUSED,
    "ENDED": STATUS_PAUSED,
    "ARCHIVED": STATUS_ARCHIVED,
}


@dataclass(slots=True)
class CampaignChange:
    """Что именно меняем в Директе: понятно, проверяемо и по одному действию."""

    kind: str  # bid | budget | status | name
    campaign_id: str | None
    keyword_id: str | None = None
    before: Any = None
    after: Any = None
    reason: str = ""
    applied: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "campaign_id": self.campaign_id,
            "keyword_id": self.keyword_id,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
            "applied": self.applied,
            "error": self.error,
        }


@dataclass(slots=True)
class ApplyResult:
    """Итог применения плана: что сделано, что не получилось и почему."""

    applied: list[CampaignChange] = field(default_factory=list)
    failed: list[CampaignChange] = field(default_factory=list)
    skipped: list[CampaignChange] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "applied": [change.to_dict() for change in self.applied],
            "failed": [change.to_dict() for change in self.failed],
            "skipped": [change.to_dict() for change in self.skipped],
            "findings": [finding.to_dict() for finding in self.findings],
            "applied_count": len(self.applied),
            "failed_count": len(self.failed),
        }

    @property
    def ok(self) -> bool:
        return not self.failed


# ─── Синхронизация с Директом ──────────────────────────────────

def normalize_campaign(row: Mapping[str, Any], user_id: int) -> dict[str, Any]:
    """Приводит кампанию из Директа к полям нашей таблицы campaigns.

    Деньги в Директе приходят в микрорублях — переводим в рубли, иначе
    бюджеты и расходы будут в миллион раз больше реальных.
    """
    status_raw = str(row.get("Status") or row.get("status") or "").upper()
    state = str(row.get("State") or row.get("state") or "").upper()

    # В Директе два разных поля: State отвечает за «включена / выключена»,
    # Status — за модерацию. Смотреть только на Status нельзя: у работающей
    # кампании Status = ACCEPTED, а выключенная вручную кампания выглядела бы
    # как активная. Поэтому сначала State, потом Status.
    if state in DIRECT_STATE_MAP:
        status = DIRECT_STATE_MAP[state]
    elif status_raw in DIRECT_STATUS_MAP:
        status = DIRECT_STATUS_MAP[status_raw]
    else:
        # Неизвестное состояние не выдаём за работающее
        status = STATUS_PAUSED

    budget = row.get("DailyBudget")
    if isinstance(budget, Mapping):
        amount = budget.get("Amount")
    else:
        amount = budget

    return {
        "user_id": user_id,
        "external_id": str(row.get("Id") or row.get("id") or ""),
        "name": str(row.get("Name") or row.get("name") or "Кампания без названия")[:256],
        "status": status,
        "daily_budget": from_micro(amount) if amount is not None else 0.0,
        "target_cpa": 0.0,
        "stats_cache": {},
    }


async def sync_campaigns(
    session: AsyncSession,
    user: User,
    campaigns: Sequence[Mapping[str, Any]],
) -> list[Campaign]:
    """Обновляет кампании в базе по данным из Директа.

    Возвращает актуальный список кампаний пользователя. Существующие записи
    обновляются (включая бюджет и статус), новые создаются.
    """
    existing_result = await session.execute(select(Campaign).where(Campaign.user_id == user.id))
    existing = {campaign.external_id: campaign for campaign in existing_result.scalars().all()}

    result: list[Campaign] = []
    for row in campaigns:
        payload = normalize_campaign(row, user.id)
        if not payload["external_id"]:
            continue

        campaign = existing.get(payload["external_id"])
        if campaign is None:
            campaign = Campaign(**payload)
            session.add(campaign)
        else:
            campaign.name = payload["name"]
            campaign.status = payload["status"]
            if payload["daily_budget"]:
                campaign.daily_budget = payload["daily_budget"]
            campaign.stats_updated_at = datetime.now(timezone.utc)
        result.append(campaign)

    await session.flush()
    log.info("Кампании синхронизированы", user_id=user.id, count=len(result))
    return result


async def store_stats(session: AsyncSession, campaign: Campaign, stats: Mapping[str, Any]) -> Campaign:
    """Складывает статистику кампании в кэш (stats_cache) — её читает интерфейс."""
    campaign.stats_cache = dict(stats)
    campaign.stats_updated_at = datetime.now(timezone.utc)
    await session.flush()
    return campaign


# ─── Применение изменений ──────────────────────────────────────

def _items(source: Any, field_name: str) -> list[Any]:
    """Достаёт список из датакласса-плана или из такого же словаря.

    Планы попадают в API двумя путями: сразу из движка (датакласс) и из
    базы, где они лежат как JSON (словарь). Обе формы должны работать —
    иначе кнопка «применить» сломается после перезагрузки страницы.
    """
    if isinstance(source, Mapping):
        items = source.get(field_name) or []
        return list(items) if isinstance(items, Iterable) else []
    items = getattr(source, field_name, None) or []
    return list(items) if isinstance(items, Iterable) else []


def _field(item: Any, *names: str, default: Any = None) -> Any:
    """Читает поле у датакласса или ключ у словаря — что попадётся."""
    for name in names:
        if isinstance(item, Mapping):
            if name in item and item[name] is not None:
                return item[name]
        else:
            value = getattr(item, name, None)
            if value is not None:
                return value
    return default


def plan_from_bid_plan(bid_plan: Any) -> list[CampaignChange]:
    """Превращает план ставок в список изменений для Директа.

    Принимает и BidPlan из движка, и его словарную копию из базы.
    """
    changes: list[CampaignChange] = []
    for change in _items(bid_plan, "changes"):
        keyword_id = _field(change, "keyword_id")
        if not keyword_id:
            continue
        current = _field(change, "current_bid_rub", "bid_rub", default=0.0)
        recommended = _field(change, "recommended_bid_rub", "new_bid_rub", default=current)
        changes.append(
            CampaignChange(
                kind="bid",
                campaign_id=_field(change, "campaign_id"),
                keyword_id=str(keyword_id),
                before=money(current),
                after=money(recommended),
                reason=str(_field(change, "reason", default="") or ""),
            ),
        )
    return changes


def plan_from_budget_plan(budget_plan: Any) -> list[CampaignChange]:
    """Превращает план распределения бюджета в изменения дневных бюджетов.

    Принимает и AllocationPlan из движка, и его словарную копию из базы.
    """
    changes: list[CampaignChange] = []
    for row in _items(budget_plan, "rows"):
        delta = to_float(_field(row, "delta_rub", default=0.0))
        if abs(delta) < 1:
            continue
        changes.append(
            CampaignChange(
                kind="budget",
                campaign_id=str(_field(row, "channel_id", "campaign_id", default="") or ""),
                before=money(_field(row, "current_daily_budget_rub", default=0.0)),
                after=money(_field(row, "new_daily_budget_rub", default=0.0)),
                reason=str(_field(row, "reason", default="") or ""),
            ),
        )
    return changes


def plan_status_changes(campaigns: Sequence[Mapping[str, Any]], *, bot_share_threshold: float = 60.0) -> list[CampaignChange]:
    """Предлагает остановить кампании, где расход есть, а смысла нет.

    Критерии: расход без заявок при достаточном числе кликов либо доля
    мусорного трафика выше порога. Останавливаем — не удаляем: решение
    обратимо в один клик.
    """
    changes: list[CampaignChange] = []
    for row in campaigns:
        clicks = int(safe_div(row.get("clicks", 0), 1))
        conversions = float(row.get("conversions", 0) or 0)
        cost = float(row.get("cost_rub", 0) or 0)
        bot_share = float(row.get("bot_share_pct", 0) or 0)
        status = str(row.get("status") or STATUS_ACTIVE)

        if status == STATUS_PAUSED:
            continue

        reason = ""
        if clicks >= 100 and conversions == 0 and cost > 3000:
            reason = (
                f"{clicks} кликов, {money(cost)} ₽ расходов и ни одной заявки — "
                "показывать дальше значит платить за воздух"
            )
        elif bot_share >= bot_share_threshold and cost > 1000:
            reason = f"{bot_share}% трафика в кампании — ботовый, деньги уходят в пустоту"

        if reason:
            changes.append(
                CampaignChange(
                    kind="status",
                    campaign_id=str(row.get("campaign_id") or row.get("external_id") or ""),
                    before=status,
                    after=STATUS_PAUSED,
                    reason=reason,
                ),
            )
    return changes


async def apply_changes(
    direct_client: Any,
    changes: Iterable[CampaignChange],
    *,
    dry_run: bool = False,
) -> ApplyResult:
    """Отправляет изменения в Яндекс.Директ.

    direct_client — клиент из services/yandex_direct.py. Каждое изменение
    выполняется отдельно: одна ошибка не блокирует остальные, а попадает
    в отчёт с понятным текстом.
    """
    result = ApplyResult()

    for change in changes:
        if dry_run:
            change.error = None
            result.skipped.append(change)
            continue

        try:
            if change.kind == "bid":
                # Формат, который понимает services.yandex_direct.DirectClient:
                # идентификатор фразы и новая ставка в рублях.
                await direct_client.set_bids([{"keyword_id": change.keyword_id, "bid_rub": float(change.after)}])
            elif change.kind == "budget":
                await direct_client.update_campaign_budget(str(change.campaign_id), float(change.after))
            elif change.kind == "status":
                await direct_client.update_campaign_status(str(change.campaign_id), str(change.after))
            else:
                result.skipped.append(change)
                continue

            change.applied = True
            result.applied.append(change)
        except Exception as error:  # noqa: BLE001 — фиксируем и продолжаем остальные
            change.error = str(error)
            result.failed.append(change)
            log.error("Не удалось применить изменение", kind=change.kind, campaign=change.campaign_id, error=str(error))

    result.findings = _apply_findings(result)
    log.info("Изменения применены", applied=len(result.applied), failed=len(result.failed), dry_run=dry_run)
    return result


def _apply_findings(result: ApplyResult) -> list[Finding]:
    """Короткий отчёт по применённым изменениям."""
    findings: list[Finding] = []

    if result.applied:
        bids = [change for change in result.applied if change.kind == "bid"]
        budgets = [change for change in result.applied if change.kind == "budget"]
        statuses = [change for change in result.applied if change.kind == "status"]
        parts = []
        if bids:
            parts.append(f"ставок — {len(bids)}")
        if budgets:
            parts.append(f"бюджетов — {len(budgets)}")
        if statuses:
            parts.append(f"статусов — {len(statuses)}")
        findings.append(
            Finding(
                code="campaign:applied",
                title="Изменения применены в Директе",
                description="Обновлено: " + ", ".join(parts) + ". Статистика подтянется в течение нескольких часов.",
                severity=SEVERITY_INFO,
                action="Вернуться к кампаниям через день и проверить CPA",
            ),
        )

    if result.failed:
        findings.append(
            Finding(
                code="campaign:failed",
                title=f"{len(result.failed)} изменений(я) не применились",
                description=(
                    "Причины чаще всего: истёк токен Директа, изменился идентификатор фразы или "
                    "превышен лимит запросов. Текст ошибки — в деталях."
                ),
                severity=SEVERITY_WARNING,
                action="Проверить подключение Директа в «Подключениях» и повторить",
                evidence={"errors": [change.error for change in result.failed if change.error][:3]},
            ),
        )

    return findings


async def pause_resume(
    session: AsyncSession,
    user: User,
    campaign_id: int,
    *,
    direct_client: Any = None,
    status: str | None = None,
) -> tuple[Campaign | None, Finding]:
    """Останавливает или запускает кампанию: сначала в Директе, потом локально."""
    result = await session.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.user_id == user.id),
    )
    campaign = result.scalar_one_or_none()
    if campaign is None:
        return None, Finding(
            code="campaign:not-found",
            title="Кампания не найдена",
            description="Возможно, она была удалена или относится к другому пользователю.",
            severity=SEVERITY_WARNING,
            action="Обновить список кампаний",
        )

    target = status or (STATUS_ACTIVE if campaign.status == STATUS_PAUSED else STATUS_PAUSED)

    if direct_client is not None:
        try:
            await direct_client.update_campaign_status(campaign.external_id, target)
        except Exception as error:  # noqa: BLE001
            log.error("Директ не принял смену статуса", campaign=campaign.external_id, error=str(error))
            return campaign, Finding(
                code="campaign:status-failed",
                title="Директ не принял изменение",
                description=(
                    "Локальный статус не изменён, чтобы данные не расходились с реальностью. "
                    f"Ошибка: {error}"
                ),
                severity=SEVERITY_WARNING,
                action="Проверить подключение Директа и повторить попытку",
            )

    campaign.status = target
    await session.flush()

    verb = "запущена" if target == STATUS_ACTIVE else "остановлена"
    return campaign, Finding(
        code="campaign:status-ok",
        title=f"Кампания «{campaign.name}» {verb}",
        description=(
            "Изменение применено и в Директе, и в приложении — данные не разойдутся."
            if direct_client is not None
            else "Изменение сохранено в приложении. Директ не подключён — примените статус в кабинете."
        ),
        severity=SEVERITY_INFO,
        action="Проверить расходы через день",
    )


def build_campaign_draft(
    *,
    name: str,
    daily_budget_rub: float,
    region_codes: Sequence[int] | None = None,
    strategy: str = "PAY_FOR_CONVERSION",
    target_cpa_rub: float = 0.0,
    start_date: str | None = None,
) -> dict[str, Any]:
    """Черновик кампании для Директа: структура, которую можно отправить в API.

    Нужен для гипотез вида «разделить по регионам» и «протестировать город»:
    пользователь видит готовый план запуска, а не абстрактное «создайте кампанию».
    """
    strategy_params: dict[str, Any] = {"WbMaximumClicks": {}, "AverageCpc": {}, "AverageCpa": {}}
    if strategy == "PAY_FOR_CONVERSION" and target_cpa_rub > 0:
        strategy_params["AverageCpa"] = {"AverageCpa": int(round(target_cpa_rub * 1_000_000))}
    else:
        strategy = "WB_MAXIMUM_CLICKS"
        strategy_params = {"WbMaximumClicks": {}}

    return {
        "Name": name[:255],
        "DailyBudget": {"Amount": int(round(daily_budget_rub * 1_000_000)), "Mode": "DISTRIBUTED"},
        "StartDate": start_date or datetime.now(timezone.utc).date().isoformat(),
        "Strategy": {"BiddingStrategyType": strategy, **strategy_params},
        "RegionIds": list(region_codes or [213]),
        "Notes": "Создано AI Маркетологом по гипотезе роста",
    }


__all__ = [
    "DIRECT_STATUS_MAP",
    "STATUS_ACTIVE",
    "STATUS_ARCHIVED",
    "STATUS_DRAFT",
    "STATUS_PAUSED",
    "ApplyResult",
    "CampaignChange",
    "apply_changes",
    "build_campaign_draft",
    "normalize_campaign",
    "pause_resume",
    "plan_from_bid_plan",
    "plan_from_budget_plan",
    "plan_status_changes",
    "store_stats",
    "sync_campaigns",
]
