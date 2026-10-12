import { config } from '../../config.js';
import { repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';

/**
 * AI-советник на OpenRouter (бесплатные модели).
 *
 * Философия продукта: все действия выполняет движок-скрипт (правила и статистика),
 * AI только объясняет цифры и предлагает, что попробовать дальше. Поэтому здесь:
 *   • нет доступа к управляющим операциям — только текст рекомендации;
 *   • обязательный фолбэк: если ключа нет или модель недоступна, советник
 *     собирает вывод из данных скрипта (никогда не оставляет пустой экран);
 *   • ответы кешируются в базе на несколько часов, чтобы не жечь лимиты.
 */

const log = rootLogger.child('ai-advisor');

/** Бесплатные модели OpenRouter: перебираем по порядку, пока не ответит. */
export const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3.1:free',
  'qwen/qwen-2.5-72b-instruct:free',
];

export interface AdvisorContext {
  tenantId: string;
  /** Что показываем: дашборд, кампании, боты, гипотезы, GEO */
  topic: 'dashboard' | 'bots' | 'campaigns' | 'geo' | 'report';
  data: Record<string, unknown>;
  /** Дополнительная задача от пользователя (свободный вопрос) */
  question?: string;
}

export interface AdvisorAnswer {
  text: string;
  /** true — ответ от модели, false — собран движком (фолбэк) */
  fromAi: boolean;
  model?: string;
  cached?: boolean;
  error?: string;
}

const SYSTEM_PROMPT = [
  'Ты — AI-советник в сервисе AI Маркетолог для рекламных агентств из России.',
  'Тебе дают точные цифры, посчитанные движком сервиса. Твоя задача — объяснить их простым языком и предложить 2-3 конкретных действия.',
  'Правила: пиши по-русски, коротко (до 120 слов), без воды и без приветствий; опирайся только на переданные цифры;',
  'если данных мало — так и скажи; используй рубли (₽), проценты и числа из данных; не выдумывай показатели, которых нет.',
  'Формат: сначала одна фраза с главным выводом, затем 2-3 пункта с действиями через «•».',
].join(' ');

async function openRouterKey(tenantId: string): Promise<{ key: string; model: string } | null> {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  const envModel = process.env.AI_MODEL?.trim();
  if (envKey) return { key: envKey, model: envModel || FREE_MODELS[0]! };

  // Ключ может быть сохранён в подключении сервиса «openrouter»
  const db = await repos();
  const account = db.account.list({ tenantId, limit: 200 }).find((item) => item.serviceId === 'openrouter' || item.serviceId === 'openai');
  if (!account) return null;
  const payload = db.secrets.load(account.id);
  if (!payload) return null;
  try {
    const { decryptJson } = await import('../../crypto.js');
    const data = decryptJson<{ apiKey?: string; token?: string; model?: string }>(payload);
    const key = data.apiKey ?? data.token;
    if (!key) return null;
    return { key, model: data.model ?? envModel ?? FREE_MODELS[0]! };
  } catch {
    return null;
  }
}

async function callModel(apiKey: string, model: string, system: string, user: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.MARK_PUBLIC_URL ?? 'https://mark.local',
        'X-Title': 'AI Marketer (MARK)',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = (await response.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
    if (!response.ok) return { ok: false, error: payload?.error?.message ?? `HTTP ${response.status}` };
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: 'Модель вернула пустой ответ' };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* --------------------------- Фолбэк без AI --------------------------- */

/** Совет, собранный движком: работает всегда, даже без ключа и без сети. */
export function fallbackAdvice(topic: AdvisorContext['topic'], data: Record<string, unknown>): string {
  const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const money = (value: number): string => `${Math.round(value).toLocaleString('ru-RU')} ₽`;

  if (topic === 'bots') {
    const percent = Math.round(n(data.botPercentage) * 10) / 10;
    const lost = n(data.botCostEstimate);
    if (!percent) return 'Данных по трафику пока мало. Загрузите лог за неделю — движок посчитает долю ботов и потери.';
    const lines = [
      percent > 15
        ? `Доля ботов ${percent}% — это выше нормы, из бюджета уходит примерно ${money(lost)}.`
        : `Доля ботов ${percent}% — в пределах нормы, но контроль стоит держать включённым.`,
      '• Включите фильтр по длительности сессии: боты почти всегда уходят раньше 5 секунд.',
      '• Добавьте регионы с аномалиями в список исключений.',
      percent > 15 ? '• Отключите показы в ночные часы 1:00–6:00 — там основная масса фальшивого трафика.' : '• Раз в неделю перепроверяйте лог: паттерны ботов меняются.',
    ];
    return lines.join('\n');
  }

  if (topic === 'campaigns') {
    const cpa = n(data.averageCpa);
    const target = n(data.targetCpa);
    const wasted = n(data.wastedSpend);
    const lines = [cpa && target ? `Средний CPA ${money(cpa)} при цели ${money(target)}.` : 'Пока мало статистики по кампаниям.', '• Отключите фразы с нулевыми конверсиями после 20+ кликов — это самый быстрый способ снизить CPA.', wasted ? `• Расход без конверсий ${money(wasted)} — перенесите его в кампании с CPA ниже целевого.` : '• Поднимите ставки на фразах с CPA ниже цели: там есть запас роста.', '• Гипотезы по автостратегиям тестируйте на одной кампании, а не на всём аккаунте.'];
    return lines.join('\n');
  }

  if (topic === 'geo') {
    const demand = n(data.totalDemand);
    const top = Array.isArray(data.topRegions) ? (data.topRegions as { name?: string; demand?: number }[]) : [];
    const lines = [
      demand ? `Суммарный спрос ${demand.toLocaleString('ru-RU')} показов в месяц.` : 'Нужен GEO-анализ по ключевым запросам.',
      top[0]?.name ? `• Начните с ${top[0]!.name}: там максимальный спрос при приемлемой цене клика.` : '• Выберите 3–5 городов с наибольшим спросом и сделайте отдельные страницы.',
      '• Для каждого города добавьте адрес, телефон и разметку LocalBusiness — это влияет на локальную выдачу.',
      '• Регионы с низким спросом не трогайте: они размывают бюджет.',
    ];
    return lines.join('\n');
  }

  if (topic === 'report') {
    return 'Отчёт собран из фактических данных: аудит, трафик, кампании и гипотезы. Отправьте его клиенту и зафиксируйте договорённости по трём действиям с наибольшим влиянием на CPA.';
  }

  // dashboard
  const score = n(data.seoScore);
  const botPercent = Math.round(n(data.botPercentage) * 10) / 10;
  const balance = n(data.balance);
  const lines = [
    score ? `SEO-балл сайта ${score}/100${score < 60 ? ' — есть критичные проблемы, начните с них' : ' — база в порядке, можно масштабировать трафик'}.` : 'Аудит ещё не запускался — это первый шаг, он занимает минуту.',
    botPercent > 10 ? `• Доля ботов ${botPercent}% — включите защиту в BotShield и отключите ночные показы.` : '• Проверьте BotShield: даже 5–10% ботов съедают бюджет незаметно.',
    '• Запустите полный цикл: аудит → автоисправления → GEO → гипотезы → отчёт клиенту.',
    balance < 1000 ? '• Баланс подходит к концу — пополните, чтобы не остановились проверки.' : '• Следите за балансом в разделе «Пополнение».',
  ];
  return lines.join('\n');
}

/* ------------------------------ Публичный API ------------------------------ */

export async function advise(context: AdvisorContext): Promise<AdvisorAnswer> {
  const db = await repos();
  const cacheKey = `advice:${context.tenantId}:${context.topic}:${context.question ? hash(context.question) : 'auto'}`;
  const cached = db.kv.get<{ text: string; at: string; model?: string }>(cacheKey);
  if (cached && Date.now() - new Date(cached.at).getTime() < 3 * 3600_000 && !context.question) {
    return { text: cached.text, fromAi: true, model: cached.model, cached: true };
  }

  const credentials = await openRouterKey(context.tenantId);
  if (!credentials) {
    return { text: fallbackAdvice(context.topic, context.data), fromAi: false, error: 'AI-ключ не подключён — совет собран движком' };
  }

  const user = context.question
    ? `Вопрос руководителя: ${context.question}\n\nДанные сервиса (JSON):\n${JSON.stringify(context.data, null, 1).slice(0, 6000)}`
    : `Тема: ${topicTitle(context.topic)}.\nДанные сервиса (JSON):\n${JSON.stringify(context.data, null, 1).slice(0, 6000)}\n\nДай вывод и 2-3 действия.`;

  const models = [credentials.model, ...FREE_MODELS.filter((model) => model !== credentials.model)];
  let lastError = '';
  for (const model of models.slice(0, 3)) {
    const result = await callModel(credentials.key, model, SYSTEM_PROMPT, user);
    if (result.ok && result.text) {
      if (!context.question) db.kv.set(cacheKey, { text: result.text, at: new Date().toISOString(), model });
      log.info(`Совет готов (${model})`);
      return { text: result.text, fromAi: true, model };
    }
    lastError = result.error ?? 'неизвестная ошибка';
    log.warn(`Модель ${model} не ответила: ${lastError}`);
  }

  return { text: fallbackAdvice(context.topic, context.data), fromAi: false, error: lastError };
}

function topicTitle(topic: AdvisorContext['topic']): string {
  return {
    dashboard: 'общая сводка агентства',
    bots: 'качество трафика (BotShield)',
    campaigns: 'эффективность рекламных кампаний',
    geo: 'региональное продвижение (GEO)',
    report: 'итоговый отчёт для клиента',
  }[topic];
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(36);
}

/** Проверка доступности AI для интерфейса настроек. */
export async function aiStatus(tenantId: string): Promise<{ configured: boolean; model?: string; models: string[] }> {
  void config;
  const credentials = await openRouterKey(tenantId);
  return { configured: Boolean(credentials), model: credentials?.model, models: FREE_MODELS };
}
