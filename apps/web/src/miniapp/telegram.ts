/**
 * Доступ к Telegram WebApp SDK.
 *
 * Внутри Telegram окно приложения получает объект window.Telegram.WebApp:
 * он даёт тему, высоту, кнопки, haptics и подписанный initData.
 * В обычном браузере (проверка на компьютере, превью, Electron) всё это
 * отсутствует — модуль подставляет безопасные заглушки, чтобы приложение
 * работало так же, просто без системных эффектов.
 */

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: TelegramWebAppUser; start_param?: string; chat_type?: string; auth_date?: number };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  ready: () => void;
  expand: () => void;
  close: () => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  enableClosingConfirmation?: () => void;
  disableVerticalSwipes?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  showAlert?: (message: string, callback?: () => void) => void;
  showConfirm?: (message: string, callback?: (ok: boolean) => void) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
  MainButton?: {
    text: string;
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    setText: (text: string) => void;
    onClick: (handler: () => void) => void;
    offClick: (handler: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
  };
  BackButton?: {
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    onClick: (handler: () => void) => void;
    offClick: (handler: () => void) => void;
  };
}

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

interface TelegramGlobal {
  Telegram?: { WebApp?: TelegramWebApp };
}

let cached: TelegramWebApp | null = null;

/** Объект WebApp или null, если приложение открыто вне Telegram. */
export function telegram(): TelegramWebApp | null {
  if (cached) return cached;
  const globalObject = globalThis as unknown as TelegramGlobal;
  const webApp = globalObject.Telegram?.WebApp;
  if (webApp && typeof webApp.ready === 'function') {
    cached = webApp;
    return webApp;
  }
  return null;
}

/** Мы внутри Telegram (а не в браузере). */
export function isTelegram(): boolean {
  return telegram() !== null;
}

/** Подписанный initData — его проверяет сервер. В браузере пусто. */
export function initData(): string {
  return telegram()?.initData ?? '';
}

export function telegramUser(): TelegramWebAppUser | null {
  return telegram()?.initDataUnsafe?.user ?? null;
}

/**
 * Стартовый параметр deep-link вида t.me/bot/app?startapp=site_123 —
 * по нему мини-приложение открывает нужный экран.
 */
export function startParam(): string {
  return telegram()?.initDataUnsafe?.start_param ?? new URLSearchParams(location.search).get('startapp') ?? '';
}

/** Первичная настройка окна: разворот на весь экран, цвета, отключение свайпов. */
export function initTelegramShell(): void {
  const app = telegram();
  if (!app) return;
  try {
    app.ready();
    app.expand();
    app.setHeaderColor?.('#000000');
    app.setBackgroundColor?.('#000000');
    app.disableVerticalSwipes?.();
  } catch {
    /* старые версии клиента — не критично */
  }
}

export function viewportHeight(): number {
  const app = telegram();
  if (app?.viewportStableHeight) return app.viewportStableHeight;
  return window.innerHeight;
}

/* ------------------------------- Haptics ------------------------------- */

type Haptic = 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning' | 'selection' | 'soft' | 'rigid';

/** Тактильный отклик: вызывается на нажатия, успехи и ошибки. */
export function haptic(kind: Haptic = 'light'): void {
  const feedback = telegram()?.HapticFeedback;
  try {
    if (!feedback) {
      // Браузер: используем вибрацию, если она поддерживается
      if (kind === 'success' || kind === 'error' || kind === 'warning') navigator.vibrate?.(kind === 'error' ? [30, 40, 30] : 25);
      else if (kind === 'selection' || kind === 'light') navigator.vibrate?.(8);
      return;
    }
    if (kind === 'success' || kind === 'error' || kind === 'warning') feedback.notificationOccurred(kind);
    else if (kind === 'selection') feedback.selectionChanged();
    else feedback.impactOccurred(kind);
  } catch {
    /* эффект не критичен */
  }
}

/** Haptic-обёртки по смыслу действия — так проще читать код экранов. */
export const tap = (): void => haptic('light');
export const press = (): void => haptic('medium');
export const success = (): void => haptic('success');
export const failure = (): void => haptic('error');
export const select = (): void => haptic('selection');

/* --------------------------- Внешние действия --------------------------- */

export function openExternal(url: string): void {
  const app = telegram();
  if (app) {
    try {
      app.openLink(url);
      return;
    } catch {
      /* ниже обычное окно */
    }
  }
  window.open(url, '_blank', 'noopener');
}

export function closeApp(): void {
  telegram()?.close();
}

export function alertUser(message: string): void {
  const app = telegram();
  if (app?.showAlert) app.showAlert(message);
  else window.alert(message);
}

/** Кнопка «Назад» внутри Telegram — для внутренних переходов мини-приложения. */
export function setBackButton(handler: (() => void) | null): void {
  const button = telegram()?.BackButton;
  if (!button) return;
  try {
    if (handler) {
      button.onClick(handler);
      button.show();
    } else {
      button.hide();
      button.offClick(() => undefined);
    }
  } catch {
    /* не критично */
  }
}

/* ------------------------- Главная кнопка (MainButton) ------------------------- */

export interface MainButtonOptions {
  text: string;
  onClick: () => void;
  loading?: boolean;
  visible?: boolean;
}

/** Нижняя системная кнопка Telegram (если доступна) — для главного действия экрана. */
export function setMainButton(options: MainButtonOptions | null): void {
  const button = telegram()?.MainButton;
  if (!button) return;
  try {
    if (!options) {
      button.hide();
      return;
    }
    button.setText(options.text);
    button.onClick(options.onClick);
    if (options.loading) button.showProgress();
    else button.hideProgress();
    if (options.visible === false) button.hide();
    else button.show();
  } catch {
    /* не критично */
  }
}
