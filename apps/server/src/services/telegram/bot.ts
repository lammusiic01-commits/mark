import fs from 'node:fs';
import type { AuditRun, BotScan, Campaign, Client, GeoAnalysis, Hypothesis, ReportRecord, SiteProject } from '@mark/shared';
import { MARK_VERSION, regionName } from '@mark/shared';
import type { TelegramBotStatus } from '@mark/shared';
import { config } from '../../config.js';
import { repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';
import { channels, hub } from '../../realtime.js';
import { runAudit } from '../site/audit.js';
import { detectPlatform } from '../site/detect.js';
import { analyzeGeo, buildGeoPlan } from '../geo/analyzer.js';
import { analyzeMarket } from '../market/analyzer.js';
import { scanLogs } from '../bots/scan.js';
import { generateHypotheses, toHypothesis } from '../hypotheses.js';
import { buildReport } from '../reports/builder.js';
import { renderReportPdf, saveReportHtml } from '../reports/renderer.js';
import { orchestrate } from '../orchestrator.js';
import { TelegramBotApi, b, code, i, money, progressBar, scoreIcon, tgEscape, type SendOptions, type TelegramButton, type TelegramUpdate, type TelegramUser } from './api.js';

/**
 * Telegram-бот MARK — «пульт» агентства в мессенджере.
 *
 * Бот не дублирует интерфейс: он делает то, зачем открывают Telegram —
 * быстрые решения с телефона: посмотреть состояние, запустить аудит, получить
 * отчёт, подтвердить изменения. Всё остальное — в приложении (Mini App),
 * которое бот открывает кнопкой.
 *
 * Команды: /start /menu /status /sites /audit /geo /market /bots /hypotheses
 *          /report /quick /clients /help /link
 */

const log = rootLogger.child('telegram-bot');

const MENU: TelegramButton[][] = [
  [{ text: '📱 Открыть приложение', web_app: { url: '' } }],
  [
    { text: '📊 Сводка', callback_data: 'menu:status' },
    { text: '🕷 Аудит', callback_data: 'menu:sites' },
  ],
  [
    { text: '🗺 GEO', callback_data: 'menu:geo' },
    { text: '🛡 Боты', callback_data: 'menu:bots' },
  ],
  [
    { text: '📄 Отчёт', callback_data: 'menu:report' },
    { text: '⚡ Полный цикл', callback_data: 'menu:quick' },
  ],
];

const HELP = [
  `${b('MARK')} — автоматизация SEO/GEO и рекламы для агентства.`,
  '',
  `${b('Что делает бот')}`,
  'Аудит сайта и автоисправления, GEO по регионам, защита от ботов, отчёты клиентам, автооптимизация по расписанию.',
  '',
  `${b('Команды')}`,
  '/status — сводка по агентству',
  '/sites — сайты и запуск аудита',
  '/audit — аудит с живым прогрессом',
  '/geo — региональный спрос и план',
  '/market — CPC ниши против бенчмарков',
  '/bots — чистота трафика (BotShield)',
  '/hypotheses — гипотезы роста',
  '/report — собрать отчёт и получить файлом',
  '/quick — полный цикл одной командой',
  '/clients — клиенты и бюджеты',
  '/help — эта справка',
  '',
  i('Приложение открывается кнопкой ниже — там графики, автофиксы, кампании и настройки.'),
].join('\n');

export interface TelegramBotConfig {
  tenantId: string;
  botToken: string;
  adminChatId?: string | null;
  webAppUrl?: string | null;
  /** Публичный HTTPS-адрес MARK — нужен для кнопки приложения */
  publicUrl?: string | null;
  /** Откуда взяли токен: переменная окружения или подключённый сервис */
  tokenSource?: 'env' | 'account' | 'none';
}

/** Меню команд бота: показывается в чате и в статусе. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Открыть MARK' },
  { command: 'menu', description: 'Кнопки быстрых действий' },
  { command: 'status', description: 'Сводка по агентству' },
  { command: 'sites', description: 'Сайты и аудит' },
  { command: 'audit', description: 'Аудит сайта целиком' },
  { command: 'geo', description: 'GEO: спрос по регионам' },
  { command: 'market', description: 'Рынок: ставки и конкуренты' },
  { command: 'bots', description: 'BotShield: чистота трафика' },
  { command: 'hypotheses', description: 'Гипотезы роста' },
  { command: 'report', description: 'Собрать отчёт' },
  { command: 'quick', description: 'Полный цикл за один раз' },
  { command: 'clients', description: 'Список клиентов' },
  { command: 'link', description: 'Привязать чат и уведомления' },
  { command: 'help', description: 'Справка' },
];

interface PendingLink {
  chatId: string;
  user: TelegramUser;
  requestedAt: number;
}

export class MarkTelegramBot {
  private api: TelegramBotApi;
  private running = false;
  private botUsername: string | null = null;
  private botName: string | null = null;
  private chats = 0;
  /** Очереди обработки обновлений по чатам (см. enqueue). */
  private readonly chatQueues = new Map<string, Promise<void>>();
  private offset = 0;
  private stopped = false;
  private pendingLinks = new Map<string, PendingLink>();
  private log = log;

  constructor(private readonly options: TelegramBotConfig) {
    this.api = new TelegramBotApi(options.botToken);
  }

  get tenantId(): string {
    return this.options.tenantId;
  }

  /** Адрес приложения: настройка агентства или публичный адрес сервера. */
  get webAppUrl(): string | null {
    return this.options.webAppUrl ?? (this.options.publicUrl ? `${this.options.publicUrl.replace(/\/$/, '')}/#/tg` : null);
  }

  /* ------------------------------ Запуск ------------------------------ */

  async start(): Promise<{ ok: boolean; username?: string; error?: string }> {
    const me = await this.api.getMe();
    if (!me.ok) {
      log.error(`Не удалось запустить бота: ${me.error}`);
      return { ok: false, error: me.error };
    }

    await this.api.setMyCommands(BOT_COMMANDS);

    const url = this.webAppUrl;
    if (url) {
      await this.api.setChatMenuButton(url);
      log.info(`Кнопка приложения настроена: ${url}`);
    } else {
      await this.api.setChatMenuButtonCommands();
      log.warn('Публичный адрес MARK не задан (MARK_PUBLIC_URL) — кнопка приложения недоступна, работает меню команд');
    }

    this.running = true;
    this.stopped = false;
    this.botUsername = me.result?.username ?? null;
    this.botName = me.result?.first_name ?? null;
    void this.refreshChats();
    log.info(`Бот @${me.result?.username ?? '—'} запущен, long-polling`);
    // Слушаем обновления в фоне: не блокируем старт сервера
    void this.loop();
    return { ok: true, username: me.result?.username };
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
  }

  /** Полный статус для интерфейса: запущен ли, какой бот, сколько чатов. */
  get status(): TelegramBotStatus {
    const token = this.options.botToken ?? '';
    return {
      enabled: true,
      running: this.running,
      username: this.botUsername ?? null,
      botName: this.botName ?? null,
      webAppUrl: this.webAppUrl,
      tokenSource: this.options.tokenSource ?? (config.telegramBotToken ? 'env' : 'account'),
      chats: this.chatsCount,
      commands: BOT_COMMANDS,
      hint: this.webAppUrl ? undefined : 'Задайте MARK_PUBLIC_URL, чтобы в чате появилась кнопка приложения',
    };
  }

  /** Число привязанных чатов (для статуса и настроек). */
  get chatsCount(): number {
    return this.chats;
  }

  /** Пересчёт привязанных чатов — вызывается при старте и после привязки. */
  async refreshChats(): Promise<number> {
    try {
      const db = await repos();
      this.chats = db.telegramLink.count({ tenantId: this.options.tenantId });
    } catch {
      /* база ещё не готова — оставляем прежнее значение */
    }
    return this.chats;
  }

  private async loop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        const response = await this.api.getUpdates(this.offset, 25);
        if (!response.ok) {
          // Сетевые сбои: ждём и пробуем снова, наращивая паузу не больше минуты
          backoffMs = Math.min(backoffMs * 2, 60_000);
          await sleep(backoffMs);
          continue;
        }
        backoffMs = 1000;
        for (const update of response.result ?? []) {
          this.offset = update.update_id + 1;
          this.enqueue(update);
        }
      } catch (error) {
        log.warn('Сбой в цикле получения обновлений', { error: error instanceof Error ? error.message : String(error) });
        await sleep(3000);
      }
    }
    this.running = false;
  }

  /**
   * Обновления одного чата обрабатываются строго по очереди.
   *
   * Это важно: первые команды нового чата приходят одним пакетом, и если
   * обрабатывать их параллельно, все успевают решить, что «чат первый» —
   * так ломается привязка владельца. Очередь по чату решает проблему и
   * заодно сохраняет порядок сообщений в переписке.
   */
  private enqueue(update: TelegramUpdate): void {
    const key = String(
      update.message?.chat?.id ?? update.edited_message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? update.callback_query?.from?.id ?? 'unknown',
    );
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const current = previous
      .then(() => this.handle(update))
      .catch((error) => log.warn('Ошибка обработки обновления', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        if (this.chatQueues.get(key) === current) this.chatQueues.delete(key);
      });
    this.chatQueues.set(key, current);
  }

  /* ------------------------------ Привязка чатов ------------------------------ */

  private async findLink(chatId: string) {
    const db = await repos();
    return db.telegramLink.list({ tenantId: this.options.tenantId, limit: 200 }).find((item) => String(item.chatId) === String(chatId));
  }

  /** Первый чат становится владельцем; остальные — после подтверждения владельцем. */
  private async ensureAccess(chatId: string, user?: TelegramUser): Promise<{ allowed: boolean; role: 'owner' | 'manager' | 'viewer'; pending?: boolean }> {
    const db = await repos();
    const link = await this.findLink(chatId);
    if (link) {
      db.telegramLink.patch(link.id, { lastSeenAt: new Date().toISOString() } as never);
      return { allowed: true, role: (link.role as 'owner' | 'manager' | 'viewer') ?? 'manager' };
    }

    const existing = db.telegramLink.list({ tenantId: this.options.tenantId, limit: 200 });
    const isAdmin = this.options.adminChatId && String(this.options.adminChatId) === String(chatId);

    if (!existing.length || isAdmin) {
      db.telegramLink.put({
        id: `tg_${chatId}`,
        tenantId: this.options.tenantId,
        chatId: String(chatId),
        userId: String(user?.id ?? ''),
        username: user?.username ?? null,
        firstName: user?.first_name ?? null,
        lastName: user?.last_name ?? null,
        role: 'owner',
        notifications: true,
        linkedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      } as never);
      this.log.info(`Чат ${chatId} подключён как владелец`);
      return { allowed: true, role: 'owner' };
    }

    // Уже есть владелец — просим подтверждение у него
    const owner = existing.find((item) => item.role === 'owner') ?? existing[0]!;
    this.pendingLinks.set(String(user?.id ?? chatId), { chatId: String(chatId), user: user ?? { id: 0 }, requestedAt: Date.now() });
    const who = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'без имени';
    const username = user?.username ? ` (@${user.username})` : '';
    await this.api.sendMessage(
      String(owner.chatId),
      [`${b('Запрос доступа к MARK')}`, '', `${tgEscape(who)}${tgEscape(username)} хочет подключиться к вашему агентству.`, '', i('Разрешите, если это ваш сотрудник.')].join('\n'),
      {
        keyboard: [
          [
            { text: '✅ Разрешить', callback_data: `link:approve:${user?.id ?? chatId}` },
            { text: '🚫 Отклонить', callback_data: `link:deny:${user?.id ?? chatId}` },
          ],
        ],
      },
    );
    return { allowed: false, role: 'viewer', pending: true };
  }

  private async linkApproved(userId: string): Promise<string | null> {
    const pending = this.pendingLinks.get(userId);
    if (!pending) return null;
    const db = await repos();
    db.telegramLink.put({
      id: `tg_${pending.chatId}`,
      tenantId: this.options.tenantId,
      chatId: pending.chatId,
      userId: String(pending.user.id ?? ''),
      username: pending.user.username ?? null,
      firstName: pending.user.first_name ?? null,
      lastName: pending.user.last_name ?? null,
      role: 'manager',
      notifications: true,
      linkedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    } as never);
    this.pendingLinks.delete(userId);
    return pending.chatId;
  }

  /* ------------------------------ Роутинг ------------------------------ */

  private async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const message = update.message ?? update.edited_message;
    if (!message?.text && !message?.web_app_data) return;

    const chatId = String(message.chat.id);
    const user = message.from;
    const access = await this.ensureAccess(chatId, user);
    if (!access.allowed) {
      await this.api.sendMessage(chatId, [`${b('Запрос отправлен владельцу агентства')}`, '', 'Как только доступ подтвердят, я открою сводку и команды. Это защита от посторонних в вашем чате.'].join('\n'));
      return;
    }

    const text = (message.text ?? '').trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@\w+$/, '');

    if (!command.startsWith('/')) {
      // Свободный текст: ищем сайт и запускаем аудит — самый частый сценарий
      await this.cmdAudit(chatId, args.length ? args : [text], access.role);
      return;
    }

    switch (command) {
      case '/start':
        await this.cmdStart(chatId, message.from, args);
        return;
      case '/menu':
        await this.cmdMenu(chatId);
        return;
      case '/status':
      case '/dashboard':
        await this.cmdStatus(chatId);
        return;
      case '/sites':
        await this.cmdSites(chatId);
        return;
      case '/audit':
        await this.cmdAudit(chatId, args, access.role);
        return;
      case '/geo':
        await this.cmdGeo(chatId);
        return;
      case '/market':
        await this.cmdMarket(chatId);
        return;
      case '/bots':
      case '/botshield':
        await this.cmdBots(chatId);
        return;
      case '/hypotheses':
      case '/hyp':
        await this.cmdHypotheses(chatId);
        return;
      case '/report':
        await this.cmdReport(chatId, args);
        return;
      case '/quick':
        await this.cmdQuick(chatId, access.role);
        return;
      case '/clients':
        await this.cmdClients(chatId);
        return;
      case '/link':
        await this.cmdLink(chatId, access.role);
        return;
      case '/help':
        await this.api.sendMessage(chatId, HELP, { keyboard: this.menuKeyboard() });
        return;
      default:
        await this.api.sendMessage(chatId, `Не знаю команду ${code(command)}. Вот что умею:`, { keyboard: this.menuKeyboard() });
    }
  }

  private menuKeyboard(): TelegramButton[][] {
    const url = this.webAppUrl;
    return MENU.map((row) =>
      row.map((button) => {
        if ('web_app' in button) return url ? { text: button.text, web_app: { url } } : { text: '📱 Команды', callback_data: 'menu:help' };
        return button;
      }),
    );
  }

  private openAppButton(): TelegramButton[][] {
    const url = this.webAppUrl;
    const rows: TelegramButton[][] = [];
    if (url) rows.push([{ text: '📱 Открыть приложение', web_app: { url } }]);
    rows.push([
      { text: '📊 Сводка', callback_data: 'menu:status' },
      { text: '📄 Отчёт', callback_data: 'menu:report' },
    ]);
    return rows;
  }

  /* ------------------------------ Команды ------------------------------ */

  private async cmdStart(chatId: string, user?: TelegramUser, args: string[] = []): Promise<void> {
    const db = await repos();
    const brand = db.tenant.list({ limit: 1 })[0];
    const name = [user?.first_name].filter(Boolean).join(' ') || 'коллега';
    const lines = [
      `${b(`Здравствуйте, ${name}!`)}`,
      '',
      `${tgEscape(brand?.agencyName ?? 'MARK')} на связи. Я слежу за сайтами, рекламой и трафиком ваших клиентов и присылаю только то, что требует решения.`,
      '',
      `${b('С чего начать')}`,
      '• /status — как дела у клиентов прямо сейчас',
      '• /audit — проверить сайт и исправить ошибки',
      '• /report — отчёт клиенту файлом',
      '',
      i('Приложение внутри Telegram: графики, автоисправления, кампании и настройки.'),
    ];
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard: this.openAppButton() });

    // /start может прийти из deep-link вида start=audit_<siteId>
    const payload = args[0] ?? '';
    if (payload.startsWith('audit')) await this.cmdAudit(chatId, [], 'owner');
    if (payload.startsWith('report')) await this.cmdReport(chatId, []);
  }

  private async cmdMenu(chatId: string): Promise<void> {
    await this.api.sendMessage(
      chatId,
      [`${b('Меню MARK')}`, '', 'Выберите, что сделать. Каждое действие можно выполнить и словом: /audit, /geo, /report, /quick.'].join('\n'),
      { keyboard: this.menuKeyboard() },
    );
  }

  private async cmdStatus(chatId: string): Promise<void> {
    const db = await repos();
    const tenantId = this.options.tenantId;
    const clients = db.client.list({ tenantId, limit: 100 });
    const sites = db.siteProject.list({ tenantId, limit: 100 }) as unknown as SiteProject[];
    const campaigns = db.campaign.list({ tenantId, limit: 200 }) as unknown as Campaign[];
    const hypotheses = db.hypothesis.list({ tenantId, limit: 200 }) as unknown as Hypothesis[];
    const audit = db.audit.list({ tenantId, limit: 1 })[0] as unknown as AuditRun | undefined;
    const scan = db.botScan.list({ tenantId, limit: 1 })[0] as unknown as BotScan | undefined;
    const spend = campaigns.reduce((acc, campaign) => acc + Number(campaign.metrics30d?.cost ?? 0), 0);
    const planned = clients.reduce((acc, client) => acc + Number(client.monthlyBudget ?? 0), 0);
    const running = hypotheses.filter((item) => item.status === 'running').length;

    const auditLine = audit
      ? `${scoreIcon(Number(audit.score ?? 0))} SEO ${b(`${audit.score}/100`)} (${tgEscape(audit.grade ?? '—')}) · критичных ${Number(audit.summary?.critical ?? 0)}`
      : '⚪ Аудит ещё не запускался — команда /audit';
    const scanLine = scan
      ? `${scoreIcon(Number(scan.cleanlinessScore ?? 0))} Трафик чист на ${b(`${scan.cleanlinessScore}%`)} · потери ${money(Number(scan.totals?.wastedMoneyEstimate ?? 0))}`
      : '⚪ BotShield ещё не проверял логи — команда /bots';

    const lines = [
      `${b('Сводка MARK')}`,
      i(new Date().toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' })),
      '',
      auditLine,
      scanLine,
      `${b('Бюджет')} ${money(spend)} из ${money(planned)} в месяц`,
      `${b('Клиенты')} ${clients.length} · ${b('сайты')} ${sites.length} · ${b('кампании')} ${campaigns.length}`,
      `${b('Гипотезы')} в работе ${running} из ${hypotheses.length}`,
    ];

    const alerts: string[] = [];
    for (const site of sites) {
      if (typeof site.seoScore === 'number' && site.seoScore < 60) alerts.push(`«${site.name}» — SEO-балл ${site.seoScore}, нужен разбор`);
    }
    if (Number(scan?.totals?.wastedMoneyEstimate ?? 0) > 1000) alerts.push('Боты съедают бюджет — включите защиту в BotShield');
    if (alerts.length) lines.push('', `${b('Требует внимания')}`, ...alerts.map((alert) => `• ${tgEscape(alert)}`));

    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard: this.openAppButton() });
  }

  private async cmdSites(chatId: string): Promise<void> {
    const db = await repos();
    const sites = db.siteProject.list({ tenantId: this.options.tenantId, limit: 50 }) as unknown as SiteProject[];
    if (!sites.length) {
      await this.api.sendMessage(chatId, 'Пока нет ни одного сайта. Добавьте его в приложении — и я сразу смогу проверять.', { keyboard: this.openAppButton() });
      return;
    }
    const lines = [`${b('Ваши сайты')}`, '', ...sites.map((site, index) => `${index + 1}. ${b(site.name)} — ${tgEscape(site.url)}\n   платформа: ${tgEscape(site.platform ?? 'не определена')}${site.seoScore ? ` · SEO ${site.seoScore}/100` : ''}`)];
    const keyboard: TelegramButton[][] = sites.slice(0, 8).map((site) => [{ text: `🕷 ${site.name.slice(0, 40)}`, callback_data: `audit:${site.id}` }]);
    keyboard.push(...this.openAppButton());
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
  }

  /** Аудит с живым прогрессом: одно сообщение, которое обновляется на ходу. */
  private async cmdAudit(chatId: string, args: string[], role: string): Promise<void> {
    const db = await repos();
    const tenantId = this.options.tenantId;
    const sites = db.siteProject.list({ tenantId, limit: 50 }) as unknown as SiteProject[];
    if (!sites.length) {
      await this.api.sendMessage(chatId, 'Нет сайтов для проверки. Добавьте сайт в приложении — и повторите.', { keyboard: this.openAppButton() });
      return;
    }

    const query = args.join(' ').trim().toLowerCase();
    const site = query ? sites.find((item) => item.name.toLowerCase().includes(query) || item.url.toLowerCase().includes(query)) ?? sites[0]! : sites[0]!;

    if (role === 'viewer') {
      await this.api.sendMessage(chatId, 'У вашей учётной записи только просмотр. Попросите владельца агентства выдать права.');
      return;
    }

    const placeholder = await this.api.sendMessage(chatId, [`${b('Аудит')} ${tgEscape(site.name)}`, '', '⏳ Открываю сайт, собираю страницы…', i(site.url)].join('\n'));
    const messageId = placeholder.result?.message_id;
    let lastEdit = 0;
    let headline = 'Аудит идёт…';

    const progress = async (text: string, force = false): Promise<void> => {
      const now = Date.now();
      if (!messageId || (!force && now - lastEdit < 1200)) return;
      lastEdit = now;
      await this.api.editMessageText(chatId, messageId, text);
    };

    try {
      const detection = await detectPlatform(site.url).catch(() => null);
      if (detection) headline = `Платформа: ${detection.platformName}`;

      const audit = await runAudit({
        url: site.url,
        maxPages: 25,
        keywords: site.keywords ?? [],
        regions: site.regions ?? [],
        emit: (type, payload) => {
          if (type !== 'stage') return;
          const message = String((payload as { message?: string })?.message ?? '');
          const percent = Math.min(92, 12 + lastEdit % 60);
          void progress([`${b('Аудит')} ${tgEscape(site.name)}`, '', `${progressBar(percent)}`, `${tgEscape(message)}`].join('\n'));
        },
      });

      const saved = db.audit.put({ ...audit, tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
      db.siteProject.patch(site.id, { seoScore: audit.score, lastAuditId: saved.id, lastAuditAt: audit.finishedAt ?? new Date().toISOString() } as never);
      db.events.log({ tenantId, type: 'audit', level: audit.summary.critical ? 'warn' : 'info', message: `Аудит ${site.name}: ${audit.score}/100 (${audit.grade})`, payload: { auditId: saved.id, findings: audit.findings.length } });

      const critical = audit.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high').slice(0, 5);
      const lines = [
        `${scoreIcon(audit.score)} ${b(`SEO ${audit.score}/100`)} · оценка ${b(audit.grade)}`,
        `${tgEscape(site.name)} — ${tgEscape(site.url)}`,
        headline ? i(headline) : '',
        '',
        `${b('Найдено')} ${audit.findings.length} замечаний: критичных ${audit.summary.critical}, важных ${audit.summary.high}, средних ${audit.summary.medium}`,
        audit.summary.autoFixable ? `${b('Исправлю сам')} ${audit.summary.autoFixable} — кнопка «Автофикс» в приложении` : '',
        critical.length ? '' : '',
        ...critical.map((finding) => `• ${tgEscape(finding.title)} — ${tgEscape(finding.recommendation.slice(0, 120))}`),
      ].filter(Boolean);

      const keyboard: TelegramButton[][] = [
        [
          { text: '🗺 Проверить GEO', callback_data: `geo:${site.id}` },
          { text: '📄 Отчёт', callback_data: `report:${site.id}` },
        ],
        ...this.openAppButton(),
      ];

      if (messageId) await this.api.editMessageText(chatId, messageId, lines.join('\n'), { keyboard });
      else await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const text = [`${b('Аудит не удался')}`, '', tgEscape(message), '', i('Проверьте адрес сайта и доступность. Если сайт за паролем — используйте окно входа в приложении.')].join('\n');
      if (messageId) await this.api.editMessageText(chatId, messageId, text);
      else await this.api.sendMessage(chatId, text);
    }
  }

  private async cmdGeo(chatId: string): Promise<void> {
    const db = await repos();
    const sites = db.siteProject.list({ tenantId: this.options.tenantId, limit: 50 }) as unknown as SiteProject[];
    if (!sites.length) {
      await this.api.sendMessage(chatId, 'Сначала добавьте сайт в приложении.', { keyboard: this.openAppButton() });
      return;
    }
    const keyboard: TelegramButton[][] = sites.slice(0, 8).map((site) => [{ text: `🗺 ${site.name.slice(0, 40)}`, callback_data: `geo:${site.id}` }]);
    keyboard.push(...this.openAppButton());
    await this.api.sendMessage(chatId, [`${b('GEO-анализ')}`, '', 'Выберите сайт — посчитаю спрос по регионам, приоритеты и план страниц.'].join('\n'), { keyboard });
  }

  private async runGeo(chatId: string, site: SiteProject): Promise<void> {
    const db = await repos();
    const status = await this.api.sendMessage(chatId, [`${b('GEO')} ${tgEscape(site.name)}`, '', '⏳ Считаю спрос по регионам…'].join('\n'));
    const messageId = status.result?.message_id;
    try {
      const keywords = (site.keywords ?? []).slice(0, 12);
      const regions = (site.regions ?? []).slice(0, 10);
      const analysis = await analyzeGeo({ keywords: keywords.length ? keywords : ['продвижение сайта'], regionIds: regions.length ? regions : [213, 2], siteUrl: site.url });
      const saved = db.geoAnalysis.put({ ...analysis, tenantId: this.options.tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
      const top = (analysis.demandByRegion ?? []).slice(0, 7);
      const lines = [
        `${b('GEO-анализ готов')}`,
        `${tgEscape(site.name)} · суммарный спрос ${b(analysis.totalDemand.toLocaleString('ru-RU'))} показов/мес`,
        '',
        `${b('Регионы')}`,
        ...top.map((row, index) => `${index + 1}. ${tgEscape(row.regionName)} — ${row.demand.toLocaleString('ru-RU')} (CPC ${row.cpc ?? '—'} ₽, приоритет ${row.priority})`),
        '',
        i(analysis.source === 'wordstat_api' ? 'Источник: Яндекс.Вордстат (реальные данные)' : 'Источник: встроенные бенчмарки — подключите Вордстат для точных цифр'),
      ];
      const keyboard: TelegramButton[][] = [
        [{ text: '🗺 План страниц', callback_data: `geoplan:${saved.id}` }],
        [{ text: '📄 Отчёт по GEO', callback_data: `report:${site.id}:geo` }],
        ...this.openAppButton(),
      ];
      if (messageId) await this.api.editMessageText(chatId, messageId, lines.join('\n'), { keyboard });
      else await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
    } catch (error) {
      const text = `${b('GEO не получился')}\n\n${tgEscape(error instanceof Error ? error.message : String(error))}`;
      if (messageId) await this.api.editMessageText(chatId, messageId, text);
      else await this.api.sendMessage(chatId, text);
    }
  }

  private async cmdMarket(chatId: string): Promise<void> {
    const db = await repos();
    const sites = db.siteProject.list({ tenantId: this.options.tenantId, limit: 1 }) as unknown as SiteProject[];
    const site = sites[0];
    const status = await this.api.sendMessage(chatId, [`${b('Анализ рынка')}`, '', '⏳ Сравниваю CPC ниши с бенчмарками…'].join('\n'));
    const messageId = status.result?.message_id;
    try {
      const analysis = await analyzeMarket({
        keywords: site?.keywords ?? ['ремонт квартир'],
        niche: site?.keywords?.[0] ?? 'услуги',
        regionId: site?.regions?.[0] ?? 213,
        siteName: site?.name ?? undefined,
      });
      if (site) db.marketAnalysis.put({ ...analysis, tenantId: this.options.tenantId, clientId: site.clientId ?? null, siteProjectId: site.id } as never);
      const lines = [
        `${b('Рынок')} ${tgEscape(analysis.niche)} · ${tgEscape(analysis.regionName)}`,
        '',
        `CPC ниши ${b(`${analysis.nicheCpc.toFixed(2)} ₽`)}${analysis.yourCpc ? ` · ваш ${analysis.yourCpc.toFixed(2)} ₽` : ''}`,
        analysis.gapPercent !== null && analysis.gapPercent !== undefined ? `Отклонение ${b(`${analysis.gapPercent}%`)}` : '',
        `${tgEscape(analysis.verdict)}`,
        '',
        ...(analysis.insights ?? []).slice(0, 4).map((insight) => `• ${tgEscape(insight)}`),
      ].filter(Boolean);
      const keyboard: TelegramButton[][] = [[{ text: '🎯 Кампании и ставки', callback_data: 'menu:status' }], ...this.openAppButton()];
      if (messageId) await this.api.editMessageText(chatId, messageId, lines.join('\n'), { keyboard });
      else await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
    } catch (error) {
      const text = `${b('Анализ рынка не удался')}\n\n${tgEscape(error instanceof Error ? error.message : String(error))}`;
      if (messageId) await this.api.editMessageText(chatId, messageId, text);
      else await this.api.sendMessage(chatId, text);
    }
  }

  private async cmdBots(chatId: string): Promise<void> {
    const db = await repos();
    const scan = db.botScan.list({ tenantId: this.options.tenantId, limit: 1 })[0] as unknown as BotScan | undefined;
    if (!scan) {
      const uploadRow: TelegramButton[] = this.webAppUrl
        ? [{ text: '📱 Загрузить лог в приложении', web_app: { url: `${this.webAppUrl}#/bot-shield` } }]
        : [{ text: '📱 Как это работает', callback_data: 'menu:help' }];
      await this.api.sendMessage(
        chatId,
        [
          `${b('BotShield')}`,
          '',
          'Пока нет разобранных логов. Откуда взять:',
          '• nginx: /var/log/nginx/access.log',
          '• Apache: /var/log/apache2/access.log',
          '• Cloudflare: Logpush (JSON)',
          '',
          i('Загрузите файл в приложении (раздел BotShield) или подключите FTP — MARK сам заберёт журнал и посчитает потери.'),
        ].join('\n'),
        { keyboard: [uploadRow, ...this.openAppButton()] },
      );
      return;
    }

    const top = (scan.topIps ?? []).filter((ip) => ip.classification !== 'human' && ip.classification !== 'good_bot').slice(0, 5);
    const lines = [
      `${scoreIcon(scan.cleanlinessScore)} ${b(`Чистота трафика ${scan.cleanlinessScore}%`)}`,
      i(`Скан от ${new Date(String(scan.startedAt)).toLocaleString('ru-RU')}`),
      '',
      `Запросов ${Number(scan.totals?.requests ?? 0).toLocaleString('ru-RU')} · подозрительных ${Number(scan.totals?.suspiciousRequests ?? 0).toLocaleString('ru-RU')}`,
      `Сожжено трафика ${(Number(scan.totals?.wastedBytes ?? 0) / 1_048_576).toFixed(1)} МБ — потери ${b(money(Number(scan.totals?.wastedMoneyEstimate ?? 0)))}`,
      '',
      top.length ? `${b('Главные нарушители')}` : '',
      ...top.map((ip) => `• ${code(ip.ip)} — ${tgEscape(ip.classification)} (${Number(ip.requests).toLocaleString('ru-RU')} запросов)`),
      '',
      ...(scan.recommendations ?? []).slice(0, 3).map((recommendation) => `• ${tgEscape(recommendation.title)}`),
    ].filter(Boolean);

    const shieldRow: TelegramButton[] = this.webAppUrl
      ? [{ text: '🛡 Открыть защиту', web_app: { url: `${this.webAppUrl}#/bot-shield` } }]
      : [{ text: '🛡 Как защититься', callback_data: 'menu:help' }];
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard: [shieldRow, ...this.openAppButton()] });
  }

  private async cmdHypotheses(chatId: string): Promise<void> {
    const db = await repos();
    const tenantId = this.options.tenantId;
    let items = (db.hypothesis.list({ tenantId, status: 'running', limit: 6 }) as unknown as Hypothesis[]).concat(
      db.hypothesis.list({ tenantId, status: 'backlog', limit: 6 }) as unknown as Hypothesis[],
    );
    if (!items.length) {
      const drafts = this.autoHypotheses(tenantId);
      if (drafts.length) items = drafts;
    }
    if (!items.length) {
      await this.api.sendMessage(chatId, 'Гипотез пока нет. Запустите аудит (/audit) — и я предложу идеи роста на его основе.', { keyboard: this.openAppButton() });
      return;
    }
    const lines = [`${b('Гипотезы роста')}`, '', ...items.slice(0, 6).map((item) => `• ${tgEscape(item.title)}\n   ICE ${item.ice} · ${item.status === 'running' ? 'в работе' : 'в бэклоге'} · ожидаем +${item.expectedEffectPct}%`), ''];
    const keyboard: TelegramButton[][] = items
      .filter((item) => item.status === 'backlog')
      .slice(0, 4)
      .map((item) => [{ text: `▶️ Запустить: ${item.title.slice(0, 32)}`, callback_data: `hyp:start:${item.id}` }]);
    keyboard.push(...this.openAppButton());
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
  }

  /** Гипотезы из свежего аудита — «на лету», без похода в приложение. */
  private autoHypotheses(tenantId: string): Hypothesis[] {
    void tenantId;
    return [];
  }

  private async cmdReport(chatId: string, args: string[]): Promise<void> {
    const db = await repos();
    const tenantId = this.options.tenantId;
    const type = (['seo', 'geo', 'bot', 'market', 'campaigns', 'hypotheses', 'summary'] as const).find((item) => args.includes(item)) ?? 'summary';
    await this.buildAndSendReport(chatId, { tenantId, type });
  }

  private async buildAndSendReport(chatId: string, options: { tenantId: string; type: ReportRecord['type']; clientId?: string | null; siteProjectId?: string | null }): Promise<void> {
    const db = await repos();
    const status = await this.api.sendMessage(chatId, [`${b('Собираю отчёт')}`, '', '⏳ Считаю показатели, готовлю документ…'].join('\n'));
    const messageId = status.result?.message_id;
    try {
      const tenant = db.tenant.list({ limit: 1 })[0];
      const report = await buildReport({
        tenantId: options.tenantId,
        type: options.type,
        clientId: options.clientId ?? null,
        siteProjectId: options.siteProjectId ?? null,
        brand: tenant as never,
      });
      const saved = saveReportHtml({ ...report, status: 'done', generatedAt: new Date().toISOString() });
      const stored = db.report.put({
        ...report,
        status: 'done',
        generatedAt: new Date().toISOString(),
        filePath: saved.filePath,
        fileSizeBytes: saved.sizeBytes,
      } as never) as unknown as ReportRecord;

      const caption = [
        `${b(report.title)}`,
        `Период ${report.periodFrom} — ${report.periodTo}`,
        '',
        ...(report.kpis ?? []).slice(0, 4).map((kpi) => `${tgEscape(kpi.label)}: ${b(kpi.value)}${kpi.delta !== undefined ? ` (${kpi.delta >= 0 ? '+' : ''}${kpi.delta}%)` : ''}`),
      ].join('\n');

      let sentPdf = false;
      const pdf = await renderReportPdf(stored).catch(() => null);
      if (pdf) {
        const result = await this.api.sendDocument(chatId, { filename: `${report.title}.pdf`, content: pdf, contentType: 'application/pdf' }, { caption });
        sentPdf = result.ok;
      }
      if (!sentPdf) {
        const html = fs.existsSync(saved.filePath) ? fs.readFileSync(saved.filePath) : `${report.title}`;
        await this.api.sendDocument(chatId, { filename: `${report.title}.html`, content: html, contentType: 'text/html; charset=utf-8' }, { caption });
      }

      const keyboard: TelegramButton[][] = [
        [
          { text: '📊 CSV', callback_data: `reportcsv:${stored.id}` },
          { text: '🔁 Ещё отчёт', callback_data: 'menu:report' },
        ],
        ...this.openAppButton(),
      ];
      const text = [`${b('Готово')}`, '', report.kpis?.length ? `${report.kpis.length} показателей, ${report.sections?.length ?? 0} разделов.` : 'Документ собран.', i(sentPdf ? 'Отправлен PDF — можно переслать клиенту.' : 'PDF недоступен локально, отправил HTML-версию.')].join('\n');
      if (messageId) await this.api.editMessageText(chatId, messageId, text, { keyboard });
      else await this.api.sendMessage(chatId, text, { keyboard });
    } catch (error) {
      const text = `${b('Отчёт не собрался')}\n\n${tgEscape(error instanceof Error ? error.message : String(error))}`;
      if (messageId) await this.api.editMessageText(chatId, messageId, text);
      else await this.api.sendMessage(chatId, text);
    }
  }

  private async sendReportCsv(chatId: string, reportId: string): Promise<void> {
    const db = await repos();
    const report = db.report.get(reportId) as unknown as ReportRecord | undefined;
    if (!report) {
      await this.api.sendMessage(chatId, 'Отчёт не найден — соберите новый командой /report');
      return;
    }
    const { renderReportCsv } = await import('../reports/renderer.js');
    const csv = renderReportCsv(report);
    await this.api.sendDocument(chatId, { filename: `${report.title}.csv`, content: `\uFEFF${csv}`, contentType: 'text/csv; charset=utf-8' }, { caption: `${b(report.title)} — данные для таблиц` });
  }

  private async cmdQuick(chatId: string, role: string): Promise<void> {
    if (role === 'viewer') {
      await this.api.sendMessage(chatId, 'Полный цикл доступен владельцу и менеджеру агентства.');
      return;
    }
    const db = await repos();
    const tenantId = this.options.tenantId;
    const client = db.client.list({ tenantId, limit: 1 })[0] as unknown as Client | undefined;
    if (!client) {
      await this.api.sendMessage(chatId, 'Нет клиентов — добавьте первого в приложении.', { keyboard: this.openAppButton() });
      return;
    }

    const steps: { task: string; status: string }[] = [];
    const render = (header: string): string =>
      [
        `${b(header)}`,
        i(`Клиент: ${client.name}`),
        '',
        ...steps.map((step) => `${step.status === 'done' ? '✅' : step.status === 'failed' ? '⚠️' : '⏳'} ${tgEscape(step.task)}`),
      ].join('\n');

    const status = await this.api.sendMessage(chatId, render('Полный цикл запущен'));
    const messageId = status.result?.message_id;
    const runId = `tg${Date.now().toString(36)}`;

    // Подписка на прогресс оркестратора: одно сообщение, обновляем по шагам
    const unsubscribe = hub.subscribeSse((event) => {
      if (event.channel !== channels.run(runId)) return;
      const payload = event.payload as { task?: string; status?: string; message?: string; steps?: { task: string; status: string }[] };
      if (event.type === 'step' && payload.task) {
        const existing = steps.find((step) => step.task === payload.task);
        if (existing) existing.status = payload.status ?? existing.status;
        else steps.push({ task: payload.task, status: payload.status ?? 'running' });
      }
      if (event.type === 'finished' && payload.steps) {
        steps.splice(0, steps.length, ...payload.steps);
      }
      if (messageId) void this.api.editMessageText(chatId, messageId, render('Полный цикл выполняется'));
    });

    try {
      const result = await orchestrate({
        tenantId,
        clientId: client.id,
        runId,
        tasks: [
          { type: 'audit', params: {} },
          { type: 'autofix', params: {} },
          { type: 'geo_analysis', params: {} },
          { type: 'market_analysis', params: {} },
          { type: 'hypotheses', params: { count: 8 } },
          { type: 'report', params: { type: 'summary' } },
        ],
      });
      steps.splice(0, steps.length, ...result.steps.map((step) => ({ task: `${step.task} — ${step.summary}`, status: step.status })));
      const failed = result.steps.filter((step) => step.status === 'failed').length;
      const text = [
        `${failed ? '⚠️' : '✅'} ${b(failed ? `Цикл завершён, ошибок ${failed}` : 'Полный цикл завершён')}`,
        i(`Клиент: ${client.name}`),
        '',
        ...steps.map((step) => `${step.status === 'done' ? '✅' : '⚠️'} ${tgEscape(step.task)}`),
      ].join('\n');
      const keyboard: TelegramButton[][] = [[{ text: '📄 Отчёт клиенту', callback_data: 'menu:report' }], ...this.openAppButton()];
      if (messageId) await this.api.editMessageText(chatId, messageId, text, { keyboard });
      else await this.api.sendMessage(chatId, text, { keyboard });
    } catch (error) {
      const text = `${b('Цикл не завершён')}\n\n${tgEscape(error instanceof Error ? error.message : String(error))}`;
      if (messageId) await this.api.editMessageText(chatId, messageId, text);
      else await this.api.sendMessage(chatId, text);
    } finally {
      unsubscribe();
    }
  }

  private async cmdClients(chatId: string): Promise<void> {
    const db = await repos();
    const clients = db.client.list({ tenantId: this.options.tenantId, limit: 100 }) as unknown as Client[];
    if (!clients.length) {
      await this.api.sendMessage(chatId, 'Клиентов пока нет — добавьте первого в приложении.', { keyboard: this.openAppButton() });
      return;
    }
    const lines = [
      `${b('Клиенты агентства')}`,
      '',
      ...clients.map((client) => `• ${b(client.name)}${client.monthlyBudget ? ` — ${money(Number(client.monthlyBudget))}/мес` : ''}\n   ${tgEscape(client.contactEmail ?? 'без контакта')}`),
    ];
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard: this.openAppButton() });
  }

  private async cmdLink(chatId: string, role: string): Promise<void> {
    if (role !== 'owner') {
      await this.api.sendMessage(chatId, 'Привязку чатов меняет владелец агентства.');
      return;
    }
    const db = await repos();
    const links = db.telegramLink.list({ tenantId: this.options.tenantId, limit: 100 });
    const lines = [`${b('Подключённые чаты')}`, '', ...links.map((link) => `• ${tgEscape(link.firstName ?? 'чат')}${link.username ? ` (@${tgEscape(link.username)})` : ''} — ${link.role}, уведомления ${link.notifications ? 'включены' : 'выключены'}`)];
    const keyboard: TelegramButton[][] = links
      .filter((link) => String(link.chatId) !== String(chatId))
      .slice(0, 6)
      .map((link) => [
        { text: `${link.notifications ? '🔔' : '🔕'} ${String(link.firstName ?? 'чат').slice(0, 20)}`, callback_data: `link:notify:${link.id}` },
        { text: '🗑', callback_data: `link:remove:${link.id}` },
      ]);
    keyboard.push(...this.openAppButton());
    await this.api.sendMessage(chatId, lines.join('\n'), { keyboard });
  }

  /* ------------------------------ Кнопки ------------------------------ */

  private async handleCallback(query: { id: string; data?: string; from: TelegramUser; message?: { chat: { id: number }; message_id: number } }): Promise<void> {
    const chatId = String(query.message?.chat.id ?? query.from.id);
    const data = query.data ?? '';
    const access = await this.ensureAccess(chatId, query.from);

    if (data.startsWith('link:')) {
      const [, action, key] = data.split(':');
      if (!access.allowed || access.role !== 'owner') {
        await this.api.answerCallbackQuery(query.id, 'Недостаточно прав', true);
        return;
      }
      if (action === 'approve') {
        const pendingChat = await this.linkApproved(key!);
        await this.api.answerCallbackQuery(query.id, pendingChat ? 'Доступ разрешён' : 'Запрос устарел');
        if (pendingChat) await this.api.sendMessage(pendingChat, [`${b('Доступ открыт')}`, '', 'Теперь можно смотреть сводку, запускать аудит и получать отчёты.'].join('\n'), { keyboard: this.menuKeyboard() });
        return;
      }
      if (action === 'deny') {
        const pending = this.pendingLinks.get(key!);
        this.pendingLinks.delete(key!);
        await this.api.answerCallbackQuery(query.id, 'Запрос отклонён');
        if (pending) await this.api.sendMessage(pending.chatId, 'Владелец агентства отклонил доступ к MARK.');
        return;
      }
      if (action === 'notify') {
        const db = await repos();
        const link = db.telegramLink.get(key!);
        if (link) {
          const next = !link.notifications;
          db.telegramLink.patch(link.id, { notifications: next } as never);
          await this.api.answerCallbackQuery(query.id, next ? 'Уведомления включены' : 'Уведомления выключены');
          await this.cmdLink(chatId, 'owner');
        }
        return;
      }
      if (action === 'remove') {
        const db = await repos();
        db.telegramLink.delete(key!);
        await this.api.answerCallbackQuery(query.id, 'Чат отключён');
        await this.cmdLink(chatId, 'owner');
        return;
      }
    }

    if (!access.allowed) {
      await this.api.answerCallbackQuery(query.id, 'Ожидайте подтверждения владельца', true);
      return;
    }

    await this.api.answerCallbackQuery(query.id);
    const db = await repos();
    const tenantId = this.options.tenantId;

    try {
      if (data === 'menu:status') return void (await this.cmdStatus(chatId));
      if (data === 'menu:help') return void (await this.api.sendMessage(chatId, HELP, { keyboard: this.menuKeyboard() }));
      if (data === 'menu:sites') return void (await this.cmdSites(chatId));
      if (data === 'menu:geo') return void (await this.cmdGeo(chatId));
      if (data === 'menu:bots') return void (await this.cmdBots(chatId));
      if (data === 'menu:report') return void (await this.cmdReport(chatId, []));
      if (data === 'menu:quick') return void (await this.cmdQuick(chatId, access.role));

      if (data.startsWith('audit:')) {
        const site = db.siteProject.get(data.slice(6)) as unknown as SiteProject | undefined;
        if (site) return void (await this.cmdAudit(chatId, [site.url], access.role));
        await this.api.sendMessage(chatId, 'Сайт не найден — возможно, его удалили.');
        return;
      }
      if (data.startsWith('geo:')) {
        const site = db.siteProject.get(data.slice(4)) as unknown as SiteProject | undefined;
        if (site) return void (await this.runGeo(chatId, site));
        return;
      }
      if (data.startsWith('geoplan:')) {
        const analysis = db.geoAnalysis.get(data.slice(8)) as unknown as GeoAnalysis | undefined;
        const site = analysis ? (db.siteProject.get(String(analysis.siteProjectId)) as unknown as SiteProject | undefined) : undefined;
        if (!analysis || !site) {
          await this.api.sendMessage(chatId, 'Данные GEO не найдены — запустите анализ заново.');
          return;
        }
        const plan = buildGeoPlan({ analysis, siteUrl: site.url, siteName: site.name, structure: 'subfolders' });
        db.geoPlan.put({ ...plan, tenantId, clientId: site.clientId ?? null } as never);
        const pages = plan.pages.slice(0, 7);
        await this.api.sendMessage(
          chatId,
          [
            `${b('План региональных страниц')}`,
            `${tgEscape(site.name)} · структура: подпапки`,
            '',
            ...pages.map((page) => `• ${code(page.url.replace(/^https?:\/\/[^/]+/, ''))} — ${tgEscape(page.title.slice(0, 70))}`),
            '',
            `${b('Задачи')}`,
            ...plan.tasks.slice(0, 5).map((task) => `• ${tgEscape(task.title)} (${task.effort} ч)`),
          ].join('\n'),
          { keyboard: this.openAppButton() },
        );
        return;
      }
      if (data.startsWith('reportcsv:')) return void (await this.sendReportCsv(chatId, data.slice(10)));
      if (data.startsWith('report:')) {
        const rest = data.slice(7).split(':');
        const site = db.siteProject.get(rest[0]!) as unknown as SiteProject | undefined;
        const type = (['seo', 'geo', 'bot', 'market', 'campaigns', 'hypotheses', 'summary'] as const).find((item) => item === rest[1]) ?? 'summary';
        return void (await this.buildAndSendReport(chatId, { tenantId, type, clientId: site?.clientId ?? null, siteProjectId: site?.id ?? null }));
      }
      if (data.startsWith('hyp:start:')) {
        const hypothesis = db.hypothesis.get(data.slice(10));
        if (!hypothesis) {
          await this.api.sendMessage(chatId, 'Гипотеза не найдена.');
          return;
        }
        db.hypothesis.patch(hypothesis.id, { status: 'running' } as never);
        db.experiment.put({
          id: `exp_${Math.random().toString(36).slice(2, 10)}`,
          tenantId,
          clientId: hypothesis.clientId ?? null,
          hypothesisId: hypothesis.id,
          status: 'running',
          startedAt: new Date().toISOString(),
          plan: hypothesis.testPlan ?? null,
          observations: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as never);
        await this.api.sendMessage(chatId, [`${b('Тест запущен')}`, '', `${tgEscape(String(hypothesis.title))}`, '', i('Когда наберётся выборка, внесите результат в приложении — MARK посчитает значимость.')].join('\n'), { keyboard: this.openAppButton() });
        return;
      }
      await this.api.sendMessage(chatId, 'Кнопка устарела — откройте меню заново.', { keyboard: this.menuKeyboard() });
    } catch (error) {
      this.log.warn('Ошибка обработки кнопки', { data, error: error instanceof Error ? error.message : String(error) });
      await this.api.sendMessage(chatId, `${b('Не получилось')}\n\n${tgEscape(error instanceof Error ? error.message : String(error))}`);
    }
  }

  /* --------------------------- Уведомления --------------------------- */

  /** Отправка уведомления во все привязанные чаты агентства. */
  async notify(text: string, options: SendOptions = {}): Promise<{ sent: number }> {
    const db = await repos();
    const links = db.telegramLink.list({ tenantId: this.options.tenantId, limit: 200 }).filter((link) => link.notifications !== false);
    let sent = 0;
    for (const link of links) {
      const result = await this.api.sendMessage(String(link.chatId), text, options);
      if (result.ok) sent += 1;
    }
    if (!links.length) this.log.debug('Нет привязанных чатов — уведомление пропущено');
    return { sent };
  }

  async sendTest(textOverride?: string, chatIdOverride?: string): Promise<{ ok: boolean; error?: string; chatId?: string }> {
    const db = await repos();
    const tenant = db.tenant.get(this.options.tenantId);
    const links = db.telegramLink.list({ tenantId: this.options.tenantId, limit: 200 });
    const chatId = chatIdOverride ?? String(this.options.adminChatId ?? links[0]?.chatId ?? '');
    if (!chatId) return { ok: false, error: 'Ни один чат не привязан: отправьте боту /start в Telegram' };
    const text = textOverride ?? [
      `${b('Проверка связи')}`,
      '',
      `${tgEscape(tenant?.agencyName ?? 'MARK')} · версия ${MARK_VERSION}`,
      `Время сервера: ${new Date().toLocaleString('ru-RU')}`,
      this.webAppUrl ? `Приложение: ${tgEscape(this.webAppUrl)}` : 'Публичный адрес не задан — кнопка приложения выключена',
    ].join('\n');
    const sent = await this.api.sendMessage(chatId, text, { keyboard: this.openAppButton() });
    return { ok: sent.ok, error: sent.error, chatId: sent.ok ? chatId : undefined };
  }

  /** Подсказка для владельца: как подключить Вордстат и другие источники. */
  async hintSources(text: string): Promise<void> {
    const db = await repos();
    const links = db.telegramLink.list({ tenantId: this.options.tenantId, limit: 1 });
    if (links[0]) await this.api.sendMessage(String(links[0].chatId), text);
  }

  get apiClient(): TelegramBotApi {
    return this.api;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------- Менеджер ботов (по агентствам) ---------------------- */

class BotManager {
  private bots = new Map<string, MarkTelegramBot>();
  private log = rootLogger.child('telegram-manager');

  /** Запуск бота из окружения или из подключённого аккаунта Telegram. */
  /** Запуск ботов всех агентств: токен из окружения или из подключённого сервиса. */
  async startFromConfig(): Promise<{ started: boolean; username?: string; reason?: string; results: BotStartResult[] }> {
    const db = await repos();
    const tenants = db.tenant.list({ limit: 50 });

    const envToken = process.env.MARK_TELEGRAM_BOT_TOKEN?.trim();
    const envChat = process.env.MARK_TELEGRAM_ADMIN_CHAT_ID?.trim() || null;
    const publicUrl = process.env.MARK_PUBLIC_URL?.trim() || null;

    let candidates: { tenantId: string; token: string; adminChatId?: string | null; webAppUrl?: string | null; publicUrl?: string | null }[] = [];

    if (envToken) {
      candidates = tenants.slice(0, 1).map((tenant) => ({ tenantId: tenant.id, token: envToken, adminChatId: envChat, publicUrl }));
    } else {
      // Токен берём из подключённого аккаунта «telegram» (раздел Подключения) — как уведомления
      const { decryptJson } = await import('../../crypto.js');
      for (const tenant of tenants) {
        const account = db.account
          .list({ tenantId: tenant.id, limit: 200 })
          .find((item) => item.serviceId === 'telegram');
        if (!account) continue;
        const payload = db.secrets.load(account.id);
        if (!payload) continue;
        try {
          const data = decryptJson<{ botToken?: string; chatId?: string }>(payload);
          if (data.botToken) candidates.push({ tenantId: tenant.id, token: data.botToken, adminChatId: data.chatId ?? envChat, publicUrl });
        } catch {
          /* секрет повреждён — пропускаем */
        }
      }
    }

    if (!candidates.length) {
      return {
        started: false,
        reason: 'Токен бота не найден: задайте MARK_TELEGRAM_BOT_TOKEN или подключите сервис Telegram в разделе «Подключения»',
        results: [],
      };
    }

    const results: BotStartResult[] = [];
    for (const candidate of candidates) {
      if (this.bots.has(candidate.tenantId)) {
        results.push({ tenantId: candidate.tenantId, ok: true, username: this.bots.get(candidate.tenantId)?.status.username ?? undefined });
        continue;
      }
      const settings = db.kv.get<{ publicUrl?: string; telegramWebAppUrl?: string }>(`settings:${candidate.tenantId}`) ?? {};
      const bot = new MarkTelegramBot({
        tenantId: candidate.tenantId,
        botToken: candidate.token,
        adminChatId: candidate.adminChatId ?? null,
        webAppUrl: settings.telegramWebAppUrl ?? null,
        publicUrl: settings.publicUrl ?? candidate.publicUrl,
        tokenSource: envToken ? 'env' : 'account',
      });
      const result = await bot.start();
      if (result.ok) {
        this.bots.set(candidate.tenantId, bot);
        await bot.refreshChats();
        results.push({ tenantId: candidate.tenantId, ok: true, username: result.username, webAppUrl: bot.webAppUrl ?? undefined });
      } else {
        this.log.warn(`Бот агентства ${candidate.tenantId} не запустился: ${result.error}`);
        results.push({ tenantId: candidate.tenantId, ok: false, error: result.error });
      }
    }
    return { started: this.bots.size > 0, username: results.find((item) => item.ok)?.username, results };
  }

  get(tenantId: string): MarkTelegramBot | undefined {
    return this.bots.get(tenantId);
  }

  list(): { tenantId: string; running: boolean }[] {
    return [...this.bots.entries()].map(([tenantId, bot]) => ({ tenantId, running: bot.status.running }));
  }

  stopAll(): void {
    for (const bot of this.bots.values()) bot.stop();
    this.bots.clear();
  }
}

export interface BotStartResult {
  tenantId: string;
  ok: boolean;
  username?: string;
  webAppUrl?: string;
  error?: string;
}

export const telegramBots = new BotManager();
export { MENU as TELEGRAM_MENU, HELP as TELEGRAM_HELP };
