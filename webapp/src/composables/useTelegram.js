/**
 * Обёртка над Telegram.WebApp SDK.
 * Вызывается один раз при старте (main.js): ready() и expand() обязательны,
 * иначе Mini App открывается в свернутом виде.
 */
export const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined

export const isTelegram = !!tg

export function initTelegram() {
  const preload = document.getElementById('preload')
  if (tg) {
    tg.ready()
    tg.expand()
    try {
      tg.setHeaderColor('#09090B')
      tg.setBackgroundColor('#09090B')
    } catch (_) { /* старые клиенты без этих методов */ }
    try { tg.enableClosingConfirmation() } catch (_) { /* не поддерживается */ }
  }
  if (preload) preload.remove()
}

/** Данные пользователя Telegram (для аватара и приветствия) */
export function telegramUser() {
  return tg?.initDataUnsafe?.user || null
}

/** Нативная кнопка «Назад» Telegram: показывается на вложенных экранах */
export function setBackButton(visible, onClick) {
  if (!tg?.BackButton) return
  tg.BackButton.offClick?.(onClick)
  if (visible) {
    tg.BackButton.onClick(onClick)
    tg.BackButton.show()
  } else {
    tg.BackButton.hide()
  }
}

/** Нативный алерт Telegram, с фолбэком для браузера */
export function alertUser(text) {
  if (tg?.showAlert) tg.showAlert(text)
  else window.alert(text)
}

export function useTelegram() {
  return {
    tg,
    isTelegram,
    user: telegramUser(),
    initData: () => tg?.initData || '',
    close: () => tg?.close(),
    alert: alertUser,
    setBackButton,
  }
}
