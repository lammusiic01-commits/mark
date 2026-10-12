/*
  Работа с Telegram WebApp SDK.
  Всё вызывается через безопасные обёртки: если приложение открыто в обычном
  браузере (проверка вёрстки, демо), вызовы просто ничего не делают и не
  ломают интерфейс.
*/
const DEV_USER_KEY = 'ai_marketer_dev_user'

function readDevUser() {
  try {
    const raw = localStorage.getItem(DEV_USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveDevUser(user) {
  try {
    localStorage.setItem(DEV_USER_KEY, JSON.stringify(user || {}))
  } catch {
    /* приватный режим — не сохраняем */
  }
}

export function useTelegram() {
  const tg = window.Telegram?.WebApp
  const haptic = tg?.HapticFeedback

  /** Пользователь: из Telegram, иначе — сохранённый для проверки в браузере. */
  const user = tg?.initDataUnsafe?.user || readDevUser() || null

  function applyViewport() {
    if (!tg) return
    // Высота «видимой» области: нужна, чтобы нижние панели не уезжали под клавиатуру
    const height = tg.viewportStableHeight || tg.viewportHeight
    if (height) document.documentElement.style.setProperty('--tg-viewport-height', `${height}px`)
    const insets = tg.safeAreaInset
    if (insets) {
      document.documentElement.style.setProperty('--tg-safe-top', `${insets.top || 0}px`)
      document.documentElement.style.setProperty('--tg-safe-bottom', `${insets.bottom || 0}px`)
    }
  }

  return {
    tg,
    user,
    initData: tg?.initData || '',
    isTelegram: Boolean(tg),

    ready: () => tg?.ready(),
    expand: () => {
      tg?.expand?.()
      applyViewport()
    },
    close: () => tg?.close?.(),
    applyViewport,

    setTheme: () => {
      if (!tg) return
      tg.setHeaderColor?.('#000000')
      tg.setBackgroundColor?.('#000000')
      // Закрытие приложения просит подтверждение — защита от случайного выхода
      tg.enableClosingConfirmation?.()
      tg.disableVerticalSwipes?.()
    },

    /** Системная кнопка «Назад»: страницы включают её, когда нужен возврат. */
    showBackButton: (callback) => {
      if (!tg?.BackButton) return
      tg.BackButton.offClick?.(callback)
      tg.BackButton.onClick(callback)
      tg.BackButton.show()
    },
    hideBackButton: () => tg?.BackButton?.hide?.(),

    /** Кнопка во всю ширину внизу экрана (используется на онбординге). */
    showMainButton: (text, callback) => {
      if (!tg?.MainButton) return
      tg.MainButton.setText(text)
      tg.MainButton.onClick(callback)
      tg.MainButton.show()
    },
    hideMainButton: () => tg?.MainButton?.hide?.(),

    openLink: (url) => {
      if (!url) return false
      if (tg?.openLink) {
        tg.openLink(url)
        return true
      }
      window.open(url, '_blank', 'noopener')
      return true
    },

    /** Системное окно сообщения; в браузере — обычный alert. */
    alert: (message) => {
      if (tg?.showAlert) {
        tg.showAlert(message)
        return
      }
      // Вне Telegram не мешаем работе приложения системным окном
      // eslint-disable-next-line no-console
      console.warn('[сообщение]', message)
    },

    haptic: {
      light: () => haptic?.impactOccurred?.('light'),
      medium: () => haptic?.impactOccurred?.('medium'),
      heavy: () => haptic?.impactOccurred?.('heavy'),
      soft: () => haptic?.impactOccurred?.('soft'),
      rigid: () => haptic?.impactOccurred?.('rigid'),
      success: () => haptic?.notificationOccurred?.('success'),
      warning: () => haptic?.notificationOccurred?.('warning'),
      error: () => haptic?.notificationOccurred?.('error'),
      select: () => haptic?.selectionChanged?.(),
    },
  }
}
