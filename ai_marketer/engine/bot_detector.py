"""Детектор ботов: находит фейковый трафик и считает утечку бюджета в рублях.

Идея простая и без магии: у живого человека есть след — он проводит на сайте
больше пары секунд, смотрит больше одной страницы, иногда возвращается.
У бота следа нет: зашёл, отскочил, исчез. Если таких «гостей» много и они
пришли из рекламы — это слив бюджета, и его видно в деньгах.

Вход: список визитов с расходами (их отдаёт Метрика/Директ через services/).
Выход: находки по шаблонам, оценка риска и сумма, которую можно вернуть.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Iterable, Sequence

from engine import (
    DAYS_IN_MONTH,
    SEVERITY_CRITICAL,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    Finding,
    money,
    monthly,
    percent,
    safe_div,
    sort_by_impact,
    to_float,
)

# Порог «мгновенного отскока»: меньше трёх секунд и одна страница
INSTANT_BOUNCE_SECONDS = 3

# Подписи известных автоматизированных клиентов (нижний регистр)
BOT_USER_AGENT_MARKERS = (
    "headlesschrome",
    "phantomjs",
    "selenium",
    "puppeteer",
    "playwright",
    "python-requests",
    "python-urllib",
    "curl/",
    "wget/",
    "go-http-client",
    "java/",
    "okhttp",
    "libwww-perl",
    "scrapy",
    "ahrefs",
    "semrush",
    "mj12bot",
    "dotbot",
    "dataprovider",
    "crawler",
    "spider",
    "bot/",
)

# Ночное окно, когда живой спрос обычно минимален
NIGHT_HOURS = (0, 1, 2, 3, 4, 5)


@dataclass(frozen=True, slots=True)
class Visit:
    """Один визит: минимум данных, которые отдают Метрика и Директ."""

    visit_id: str
    date: str  # YYYY-MM-DD
    duration_seconds: int = 0
    page_views: int = 0
    is_bounce: bool = True
    source: str = "ad"  # ad | organic | direct | referral | social
    cost_rub: float = 0.0
    campaign_id: str | None = None
    campaign_name: str | None = None
    ip: str | None = None
    user_agent: str | None = None
    search_phrase: str | None = None
    region_code: int | None = None
    conversions: int = 0
    hour: int | None = None
    # Антифрод Метрики (поле isRobotPro, только счётчики Метрики Про):
    # если Яндекс сам пометил визит роботным — это самая надёжная улика.
    is_robot_pro: bool = False

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Visit":
        """Собирает визит из строки отчёта, терпимо к названиям полей."""
        hour = row.get("hour")
        return cls(
            visit_id=str(row.get("visit_id") or row.get("id") or ""),
            date=str(row.get("date") or ""),
            duration_seconds=int(to_float(row.get("duration_seconds") or row.get("duration"))),
            page_views=int(to_float(row.get("page_views") or row.get("pv"))),
            is_bounce=bool(row.get("is_bounce", row.get("bounce", True))),
            source=str(row.get("source") or "ad"),
            cost_rub=to_float(row.get("cost_rub") or row.get("cost")),
            campaign_id=str(row["campaign_id"]) if row.get("campaign_id") else None,
            campaign_name=row.get("campaign_name"),
            ip=row.get("ip"),
            user_agent=row.get("user_agent"),
            search_phrase=row.get("search_phrase"),
            region_code=int(to_float(row.get("region_code"))) or None,
            conversions=int(to_float(row.get("conversions"))),
            hour=int(to_float(hour)) if hour is not None and str(hour) != "" else None,
            is_robot_pro=to_float(row.get("is_robot_pro", row.get("isRobotPro"))) == 1,
        )

    @property
    def is_instant_bounce(self) -> bool:
        """Мгновенный отскок — главный признак автоматического визита."""
        return self.is_bounce and self.duration_seconds <= INSTANT_BOUNCE_SECONDS and self.page_views <= 1

    @property
    def is_suspicious_user_agent(self) -> bool:
        ua = (self.user_agent or "").strip().lower()
        if not ua:
            return True  # пустой User-Agent у обычных браузеров не встречается
        return any(marker in ua for marker in BOT_USER_AGENT_MARKERS)

    @property
    def is_night(self) -> bool:
        return self.hour is not None and self.hour in NIGHT_HOURS


@dataclass(slots=True)
class BotPattern:
    """Шаблон аномалии: сколько визитов, сколько денег и что делать."""

    code: str
    title: str
    description: str
    severity: str
    visits: int
    share_pct: float
    wasted_rub: float
    action: str
    samples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "title": self.title,
            "description": self.description,
            "severity": self.severity,
            "visits": self.visits,
            "share_pct": self.share_pct,
            "wasted_rub": money(self.wasted_rub),
            "action": self.action,
            "samples": self.samples[:5],
        }


@dataclass(slots=True)
class BotReport:
    """Итог проверки: цифры для дашборда, находки и график по дням."""

    total_visits: int
    suspicious_visits: int
    suspicious_share_pct: float
    wasted_rub: float
    monthly_savings_rub: float
    risk_score: int
    patterns: list[BotPattern]
    daily: list[dict[str, Any]]
    campaigns_at_risk: list[dict[str, Any]]
    findings: list[Finding]
    days: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_visits": self.total_visits,
            "suspicious_visits": self.suspicious_visits,
            "suspicious_share_pct": self.suspicious_share_pct,
            "wasted_rub": money(self.wasted_rub),
            "monthly_savings_rub": money(self.monthly_savings_rub),
            "risk_score": self.risk_score,
            "patterns": [pattern.to_dict() for pattern in self.patterns],
            "daily": self.daily,
            "campaigns_at_risk": self.campaigns_at_risk,
            "findings": [finding.to_dict() for finding in self.findings],
            "days": self.days,
        }

    @property
    def is_clean(self) -> bool:
        """Аномалий не найдено — трафик выглядит живым."""
        return self.suspicious_visits == 0 or self.risk_score < 15


def detect_bots(
    visits: Sequence[Visit | dict[str, Any]],
    *,
    days: int | None = None,
    conversion_price_rub: float = 0.0,
) -> BotReport:
    """Главная функция детектора: разбирает визиты и отдаёт отчёт.

    days — длина периода (по умолчанию считается по датам визитов).
    conversion_price_rub — сколько стоит нам одна конверсия, чтобы посчитать
    упущенную выгоду от потерянных показов (по умолчанию не учитывается).
    """
    normalized = [item if isinstance(item, Visit) else Visit.from_row(item) for item in visits]
    period_days = days or _period_days(normalized)
    total_visits = len(normalized)
    total_cost = money(sum(visit.cost_rub for visit in normalized))

    if total_visits == 0:
        return BotReport(
            total_visits=0,
            suspicious_visits=0,
            suspicious_share_pct=0.0,
            wasted_rub=0.0,
            monthly_savings_rub=0.0,
            risk_score=0,
            patterns=[],
            daily=[],
            campaigns_at_risk=[],
            findings=[
                Finding(
                    code="bots:no-data",
                    title="Нет данных для проверки",
                    description="За выбранный период не пришло ни одного визита — проверьте подключение Метрики и диапазон дат.",
                    severity=SEVERITY_INFO,
                    action="Подключить Яндекс.Метрику в разделе «Подключения»",
                ),
            ],
            days=period_days,
        )

    patterns: list[BotPattern] = []
    suspicious_ids: set[str] = set()

    # ─── Шаблон 0: антифрод Метрики (самая надёжная улика) ─────
    # Поле isRobotPro заполняется только на счётчиках Метрики Про, поэтому
    # шаблон появляется не всегда — но если появился, спорить не с чем.
    robots_pro = [visit for visit in normalized if visit.is_robot_pro]
    if robots_pro:
        _collect(suspicious_ids, robots_pro)
        share = percent(len(robots_pro), total_visits)
        patterns.append(
            BotPattern(
                code="direct-antifraud",
                title="Метрика пометила визиты роботными",
                description=(
                    f"{len(robots_pro)} визитов ({share}%) Яндекс.Метрика сама отметила как роботные "
                    "по данным антифрода Директа и поведению на сайте. Это не догадка — "
                    "это отметка самого Яндекса, и такие визиты не должны стоить вам денег."
                ),
                severity=SEVERITY_CRITICAL,
                visits=len(robots_pro),
                share_pct=share,
                wasted_rub=money(sum(visit.cost_rub for visit in robots_pro)),
                action="Включить контроль роботности в кампаниях и исключить площадки, откуда пришли эти визиты",
                samples=_samples(robots_pro, key="user_agent"),
            ),
        )

    # ─── Шаблон 1: мгновенные отскоки (основной признак) ───────
    instant = [visit for visit in normalized if visit.is_instant_bounce]
    if instant:
        _collect(suspicious_ids, instant)
        share = percent(len(instant), total_visits)
        waste = money(sum(visit.cost_rub for visit in instant))
        severity = SEVERITY_CRITICAL if share >= 25 else SEVERITY_WARNING if share >= 10 else SEVERITY_INFO
        patterns.append(
            BotPattern(
                code="instant-bounce",
                title="Мгновенные отскоки",
                description=(
                    f"{len(instant)} визитов ({share}%) длились меньше {INSTANT_BOUNCE_SECONDS} секунд "
                    "и не открыли вторую страницу. Живой человек так себя не ведёт — "
                    "это либо боты, либо случайные клики по объявлению."
                ),
                severity=severity,
                visits=len(instant),
                share_pct=share,
                wasted_rub=waste,
                action=(
                    "Включить фильтр ботов по этому признаку в Метрике и отключить неэффективные площадки, "
                    "если трафик идёт из сетей"
                ),
                samples=_samples(instant),
            ),
        )

    # ─── Шаблон 2: автоматизированный User-Agent ───────────────
    ua_suspicious = [visit for visit in normalized if visit.is_suspicious_user_agent]
    if ua_suspicious:
        _collect(suspicious_ids, ua_suspicious)
        share = percent(len(ua_suspicious), total_visits)
        patterns.append(
            BotPattern(
                code="user-agent",
                title="Известные боты и пустой User-Agent",
                description=(
                    f"{len(ua_suspicious)} визитов ({share}%) пришли от автоматизированных клиентов "
                    "(headless-браузеры, скрипты, парсеры) или вообще без идентификации."
                ),
                severity=SEVERITY_CRITICAL if share >= 15 else SEVERITY_WARNING,
                visits=len(ua_suspicious),
                share_pct=share,
                wasted_rub=money(sum(visit.cost_rub for visit in ua_suspicious)),
                action="Добавить исключения в фильтр ботов Метрики и запретить эти источники в настройках кампаний",
                samples=_samples(ua_suspicious, key="user_agent"),
            ),
        )

    # ─── Шаблон 3: кластеры с одного IP ────────────────────────
    ip_groups = _group_by(normalized, key=lambda visit: visit.ip)
    ip_clusters = {
        ip: group
        for ip, group in ip_groups.items()
        if ip and len(group) >= 5 and sum(visit.conversions for visit in group) == 0
    }
    if ip_clusters:
        cluster_visits = [visit for group in ip_clusters.values() for visit in group]
        _collect(suspicious_ids, cluster_visits)
        patterns.append(
            BotPattern(
                code="ip-cluster",
                title="Серии визитов с одного адреса",
                description=(
                    f"{len(ip_clusters)} адрес(ов) дали {len(cluster_visits)} визитов и ни одной конверсии. "
                    "Массовые заходы с одного IP без результата — типичная накрутка или парсер."
                ),
                severity=SEVERITY_CRITICAL if len(cluster_visits) >= 20 else SEVERITY_WARNING,
                visits=len(cluster_visits),
                share_pct=percent(len(cluster_visits), total_visits),
                wasted_rub=money(sum(visit.cost_rub for visit in cluster_visits)),
                action="Заблокировать адреса в настройках кампаний и включить защиту от накрутки показов",
                samples=list(ip_clusters)[:5],
            ),
        )

    # ─── Шаблон 4: ночная активность без конверсий ─────────────
    night = [visit for visit in normalized if visit.is_night]
    night_conversions = sum(visit.conversions for visit in night)
    if night and percent(len(night), total_visits) >= 20 and night_conversions == 0:
        _collect(suspicious_ids, night)
        patterns.append(
            BotPattern(
                code="night-activity",
                title="Ночной трафик без результата",
                description=(
                    f"{len(night)} визитов ({percent(len(night), total_visits)}%) пришлись на 00:00–06:00 "
                    "и не дали ни одной конверсии. Часто это автоматические обходы по расписанию."
                ),
                severity=SEVERITY_WARNING,
                visits=len(night),
                share_pct=percent(len(night), total_visits),
                wasted_rub=money(sum(visit.cost_rub for visit in night)),
                action="Ограничить показы по времени суток и проверить ночную статистику через неделю",
            ),
        )

    # ─── Шаблон 5: конверсионная засуха при большом трафике ────
    conversions_total = sum(visit.conversions for visit in normalized)
    click_cost = safe_div(total_cost, total_visits)
    if total_visits >= 100 and conversions_total == 0:
        patterns.append(
            BotPattern(
                code="conversion-drought",
                title="Нет конверсий при платном трафике",
                description=(
                    f"{total_visits} визитов и {money(total_cost)} ₽ расходов без единой конверсии. "
                    "Либо трафик нецелевой, либо в цели Метрики не попадают настоящие заявки."
                ),
                severity=SEVERITY_CRITICAL,
                visits=total_visits,
                share_pct=100.0,
                wasted_rub=money(total_cost),
                action="Проверить цели Метрики и качество трафика: включить поиск по фразам с конверсиями",
            ),
        )

    # ─── Шаблон 6: реферальный «мусор» ──────────────────────────
    referral = [visit for visit in normalized if visit.source in {"referral", "social"}]
    referral_dead = [visit for visit in referral if visit.is_instant_bounce or visit.conversions == 0]
    if len(referral) >= 10 and percent(len(referral_dead), len(referral)) >= 80:
        _collect(suspicious_ids, referral_dead)
        patterns.append(
            BotPattern(
                code="referral-spam",
                title="Спам-источники",
                description=(
                    f"{len(referral_dead)} из {len(referral)} визитов из внешних источников не дали "
                    "ни просмотра, ни конверсии — это реферальный спам."
                ),
                severity=SEVERITY_WARNING,
                visits=len(referral_dead),
                share_pct=percent(len(referral_dead), total_visits),
                wasted_rub=money(sum(visit.cost_rub for visit in referral_dead)),
                action="Добавить спам-домены в исключения и отключить показ на них",
                samples=_samples(referral_dead, key="user_agent"),
            ),
        )

    # ─── Итоги ────────────────────────────────────────────────
    suspicious_list = [visit for visit in normalized if visit.visit_id in suspicious_ids]
    wasted = money(sum(visit.cost_rub for visit in suspicious_list))
    suspicious_share = percent(len(suspicious_list), total_visits)
    risk_score = _risk_score(suspicious_share, ua_suspicious, instant, total_visits, conversions_total)

    # Не учитываем упущенную выгоду, если цена конверсии неизвестна
    lost_profit = money(len(suspicious_list) * conversion_price_rub) if conversion_price_rub > 0 else 0.0
    monthly_savings = monthly(wasted, period_days)
    if lost_profit:
        monthly_savings = money(monthly_savings + monthly(lost_profit, period_days))

    findings = _findings(patterns, risk_score, monthly_savings, click_cost)
    patterns.sort(key=lambda pattern: pattern.wasted_rub, reverse=True)

    return BotReport(
        total_visits=total_visits,
        suspicious_visits=len(suspicious_list),
        suspicious_share_pct=suspicious_share,
        wasted_rub=wasted,
        monthly_savings_rub=monthly_savings,
        risk_score=risk_score,
        patterns=patterns,
        daily=_daily_series(normalized, suspicious_ids, period_days),
        campaigns_at_risk=_campaign_breakdown(normalized, suspicious_ids),
        findings=findings,
        days=period_days,
    )


def _collect(container: set[str], visits: Iterable[Visit]) -> None:
    """Добавляет визиты в общий список подозрительных (без дублей)."""
    for visit in visits:
        if visit.visit_id:
            container.add(visit.visit_id)


def _group_by(visits: Sequence[Visit], key: Any) -> dict[str, list[Visit]]:
    """Группирует визиты по ключу (например, по IP-адресу)."""
    groups: dict[str, list[Visit]] = {}
    for visit in visits:
        group_key = key(visit)
        if not group_key:
            continue
        groups.setdefault(str(group_key), []).append(visit)
    return groups


def _period_days(visits: Sequence[Visit]) -> int:
    """Длина периода по датам визитов (минимум один день)."""
    dates = sorted({visit.date for visit in visits if visit.date})
    if len(dates) < 2:
        return max(1, len(dates)) or 1
    try:
        first = date.fromisoformat(dates[0])
        last = date.fromisoformat(dates[-1])
    except ValueError:
        return max(1, len(dates))
    return max(1, (last - first).days + 1)


def _daily_series(
    visits: Sequence[Visit],
    suspicious_ids: set[str],
    days: int,
) -> list[dict[str, Any]]:
    """Ряд по дням для графика «30 дней»: всего, подозрительных, расход, экономия."""
    if not visits:
        return []

    buckets: dict[str, dict[str, float]] = {}
    for visit in visits:
        bucket = buckets.setdefault(visit.date, {"total": 0, "suspicious": 0, "cost": 0.0, "wasted": 0.0})
        bucket["total"] += 1
        bucket["cost"] += visit.cost_rub
        if visit.visit_id in suspicious_ids:
            bucket["suspicious"] += 1
            bucket["wasted"] += visit.cost_rub

    return [
        {
            "date": day,
            "visits": int(bucket["total"]),
            "suspicious": int(bucket["suspicious"]),
            "cost_rub": money(bucket["cost"]),
            "wasted_rub": money(bucket["wasted"]),
        }
        for day, bucket in sorted(buckets.items())
    ]


def _campaign_breakdown(visits: Sequence[Visit], suspicious_ids: set[str]) -> list[dict[str, Any]]:
    """Разбивка по кампаниям: где именно утекает бюджет."""
    buckets: dict[str, dict[str, Any]] = {}
    for visit in visits:
        key = visit.campaign_id or visit.campaign_name or "без кампании"
        bucket = buckets.setdefault(
            key,
            {"campaign_id": visit.campaign_id, "campaign_name": visit.campaign_name or key,
             "visits": 0, "suspicious": 0, "cost_rub": 0.0, "wasted_rub": 0.0, "conversions": 0},
        )
        bucket["visits"] += 1
        bucket["cost_rub"] += visit.cost_rub
        bucket["conversions"] += visit.conversions
        if visit.visit_id in suspicious_ids:
            bucket["suspicious"] += 1
            bucket["wasted_rub"] += visit.cost_rub

    rows = []
    for bucket in buckets.values():
        rows.append(
            {
                **bucket,
                "cost_rub": money(bucket["cost_rub"]),
                "wasted_rub": money(bucket["wasted_rub"]),
                "suspicious_share_pct": percent(bucket["suspicious"], bucket["visits"]),
            },
        )
    rows.sort(key=lambda row: row["wasted_rub"], reverse=True)
    return rows


def _risk_score(
    suspicious_share: float,
    ua_suspicious: Sequence[Visit],
    instant: Sequence[Visit],
    total: int,
    conversions: int,
) -> int:
    """Оценка риска 0–100: чем выше, тем больше денег утекает."""
    score = 0.0
    score += min(45.0, suspicious_share * 1.2)
    if ua_suspicious:
        score += min(20.0, percent(len(ua_suspicious), total) * 1.5)
    if instant:
        score += min(20.0, percent(len(instant), total) * 0.8)
    if total >= 100 and conversions == 0:
        score += 15.0
    return int(min(100, round(score)))


def _samples(visits: Sequence[Visit], key: str = "ip", limit: int = 5) -> list[str]:
    """Примеры для доказательства в отчёте (IP, User-Agent или фраза)."""
    values: list[str] = []
    for visit in visits:
        if key == "user_agent":
            value = (visit.user_agent or "пустой User-Agent")[:80]
        elif key == "search_phrase":
            value = visit.search_phrase or ""
        else:
            value = visit.ip or ""
        if value and value not in values:
            values.append(value)
        if len(values) >= limit:
            break
    return values


def _findings(
    patterns: Sequence[BotPattern],
    risk_score: int,
    monthly_savings: float,
    click_cost: float,
) -> list[Finding]:
    """Превращает шаблоны в понятные находки для интерфейса и отчёта."""
    findings: list[Finding] = []
    for pattern in patterns:
        findings.append(
            Finding(
                code=f"bots:{pattern.code}",
                title=pattern.title,
                description=pattern.description,
                severity=pattern.severity,
                impact_rub=monthly(pattern.wasted_rub, DAYS_IN_MONTH),
                action=pattern.action,
                evidence={
                    "visits": pattern.visits,
                    "share_pct": pattern.share_pct,
                    "wasted_rub": money(pattern.wasted_rub),
                    "samples": pattern.samples,
                },
            ),
        )

    if risk_score >= 50:
        findings.append(
            Finding(
                code="bots:summary-critical",
                title="Бюджет утекает прямо сейчас",
                description=(
                    f"Оценка риска {risk_score}/100. По оценке движка можно вернуть "
                    f"{money(monthly_savings)} ₽ в месяц, отключив мусорный трафик."
                ),
                severity=SEVERITY_CRITICAL,
                impact_rub=monthly_savings,
                action="Применить рекомендованные действия в разделе «Защита от ботов»",
                evidence={"risk_score": risk_score, "click_cost_rub": money(click_cost)},
            ),
        )
    elif risk_score >= 15:
        findings.append(
            Finding(
                code="bots:summary-warning",
                title="Есть подозрительный трафик",
                description=(
                    f"Оценка риска {risk_score}/100. Потенциальная экономия — {money(monthly_savings)} ₽ в месяц."
                ),
                severity=SEVERITY_WARNING,
                impact_rub=monthly_savings,
                action="Проверить шаблоны ниже и применить фильтры",
                evidence={"risk_score": risk_score},
            ),
        )
    else:
        findings.append(
            Finding(
                code="bots:summary-ok",
                title="Трафик выглядит живым",
                description="Признаков накрутки не найдено: доля подозрительных визитов в пределах нормы.",
                severity=SEVERITY_INFO,
                impact_rub=0.0,
                action="Продолжать следить за статистикой — проверка автоматическая",
                evidence={"risk_score": risk_score},
            ),
        )

    return sort_by_impact(findings)


def build_demo_visits(days: int = 14, per_day: int = 40) -> list[Visit]:
    """Тестовый набор визитов (для демонстрации и автотестов).

    Две трети — живые люди, треть — явные боты со всеми признаками.
    """
    visits: list[Visit] = []
    start = date.today() - timedelta(days=days - 1)
    for day_index in range(days):
        current = (start + timedelta(days=day_index)).isoformat()
        for index in range(per_day):
            is_bot = index % 3 == 0
            if is_bot:
                visits.append(
                    Visit(
                        visit_id=f"{current}-bot-{index}",
                        date=current,
                        duration_seconds=1,
                        page_views=1,
                        is_bounce=True,
                        source="ad",
                        cost_rub=42.5,
                        campaign_id="campaign-1",
                        campaign_name="Поиск — основные",
                        ip=f"45.89.{index}.{day_index}",
                        user_agent="Mozilla/5.0 (compatible; HeadlessChrome/120.0)",
                        hour=3,
                        region_code=213,
                    ),
                )
            else:
                visits.append(
                    Visit(
                        visit_id=f"{current}-human-{index}",
                        date=current,
                        duration_seconds=180 + index * 7,
                        page_views=3 + (index % 4),
                        is_bounce=False,
                        source="ad",
                        cost_rub=38.0,
                        campaign_id="campaign-1",
                        campaign_name="Поиск — основные",
                        ip=f"95.24.{index}.{day_index}",
                        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36",
                        hour=12 + (index % 8),
                        region_code=213,
                        conversions=1 if index % 7 == 0 else 0,
                    ),
                )
    return visits


__all__ = [
    "BOT_USER_AGENT_MARKERS",
    "BotPattern",
    "BotReport",
    "INSTANT_BOUNCE_SECONDS",
    "Visit",
    "build_demo_visits",
    "detect_bots",
]
