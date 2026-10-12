import { computed, ref } from 'vue';
import { tgApi, type MiniSession, type MiniSummary } from './api';
import { select, startParam } from './telegram';
import { toastOk } from './useToasts';

/**
 * Состояние мини-приложения: сессия, сводка, навигация и шторки.
 *
 * Здесь только то, что нужно всем экранам сразу: кто вошёл, какие цифры на
 * дашборде, какой экран открыт. Данные конкретных разделов каждый экран
 * загружает сам — так приложение быстро открывается и не тянет лишнее.
 */

export type MiniScreen = 'onboarding' | 'dashboard' | 'growth' | 'bots' | 'campaigns' | 'hypotheses' | 'balance' | 'connect' | 'reports' | 'settings' | 'more';

export const SCREEN_TITLES: Record<MiniScreen, string> = {
  onboarding: 'Настройка',
  dashboard: 'Дашборд',
  growth: 'Рост и SEO',
  bots: 'BotShield',
  campaigns: 'Кампании',
  hypotheses: 'Гипотезы',
  balance: 'Баланс',
  connect: 'Подключения',
  reports: 'Отчёты',
  settings: 'Настройки',
  more: 'Ещё',
};

export const session = ref<MiniSession | null>(null);
export const summary = ref<MiniSummary | null>(null);
export const loadingSession = ref(true);
export const currentScreen = ref<MiniScreen>('dashboard');
export const previousScreen = ref<MiniScreen | null>(null);
export const bootError = ref<string | null>(null);

/** Активный клиент: мини-приложение показывает данные того агентства, чей чат привязан. */
export const activeClientId = ref<string | null>(null);

export const currency = computed(() => 'RUB');

/** Загрузка сведений о пользователе и агентстве — выполняется один раз при открытии. */
export async function loadSession(force = false): Promise<MiniSession | null> {
  if (session.value && !force) return session.value;
  loadingSession.value = true;
  try {
    session.value = await tgApi.get<MiniSession>('/me');
    bootError.value = null;
    currentScreen.value = session.value.onboarding ? resolveStartScreen() : 'onboarding';
    return session.value;
  } catch (error) {
    bootError.value = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    loadingSession.value = false;
  }
}

/** Экран при открытии: deep-link из бота (startapp) или дашборд. */
function resolveStartScreen(): MiniScreen {
  const param = startParam().toLowerCase();
  const map: Record<string, MiniScreen> = {
    bots: 'bots',
    botshield: 'bots',
    campaigns: 'campaigns',
    connect: 'connect',
    balance: 'balance',
    hypotheses: 'hypotheses',
    reports: 'reports',
    growth: 'growth',
    sites: 'growth',
    geo: 'growth',
    settings: 'settings',
  };
  return map[param] ?? 'dashboard';
}

export async function refreshSummary(): Promise<MiniSummary | null> {
  try {
    summary.value = await tgApi.get<MiniSummary>('/dashboard/summary');
    return summary.value;
  } catch {
    return null;
  }
}

export function go(screen: MiniScreen, remember = true): void {
  if (screen === currentScreen.value) return;
  if (remember) previousScreen.value = currentScreen.value;
  currentScreen.value = screen;
  select();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Возврат на предыдущий экран (системная кнопка «назад» в Telegram). */
export function back(): void {
  go(previousScreen.value ?? 'dashboard', false);
}

export async function completeOnboarding(): Promise<void> {
  try {
    await tgApi.post('/onboarding/complete', {});
    if (session.value) session.value.onboarding = true;
    go('dashboard');
    toastOk('Готово', 'Приложение настроено. Дальше — на дашборде.');
  } catch {
    go('dashboard');
  }
}

export const isOwner = computed(() => session.value?.session.role === 'owner');
export const userName = computed(() => session.value?.session.firstName ?? 'коллега');
export const agencyName = computed(() => session.value?.tenant.agencyName ?? 'AI Маркетолог');
export const isVerified = computed(() => session.value?.session.verified ?? false);
