/*
  Подготовка тестовой среды.

  Приложение общается с сервером относительными адресами ('/api') — так и должно
  быть: страница не знает, где живёт API. В тестах перехватываем fetch и
  направляем запросы на живой сервер (адрес берём из SMOKE_API, по умолчанию
  http://127.0.0.1:8000). Если сервера нет — тесты проверки экранов
  пропускаются, шаблонные тесты продолжают работать.
*/

// jsdom не умеет matchMedia — компоненты проверяют её для анимаций
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })
}

// requestAnimationFrame есть не везде, а анимации на нём
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
  window.cancelAnimationFrame = (id) => clearTimeout(id)
}

export const API_ORIGIN = process.env.SMOKE_API || 'http://127.0.0.1:8000'

const realFetch = globalThis.fetch?.bind(globalThis)

/**
  Живой API доступен? Проверяем один раз на весь прогон.
  Любой ответ считается признаком работающего сервера: /health отдаёт 503,
  если недоступен Redis, но приложение при этом полностью работоспособно.
*/
export async function apiAvailable() {
  try {
    await realFetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(2500) })
    return true
  } catch {
    return false
  }
}

if (realFetch) {
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return realFetch(`${API_ORIGIN}${input}`, init)
    }
    return realFetch(input, init)
  }
}

/* Telegram SDK подменяем заглушкой: в тестах окна мессенджера нет. */
window.Telegram = {
  WebApp: {
    initData: '',
    initDataUnsafe: { user: { id: 1, first_name: 'Игорь' } },
    colorScheme: 'dark',
    themeParams: {},
    isExpanded: true,
    viewportHeight: 844,
    viewportStableHeight: 844,
    ready() {},
    expand() {},
    close() {},
    onEvent() {},
    offEvent() {},
    enableClosingConfirmation() {},
    disableClosingConfirmation() {},
    openLink() {},
    openTelegramLink() {},
    showAlert() {},
    HapticFeedback: {
      impactOccurred() {},
      notificationOccurred() {},
      selectionChanged() {},
    },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    MainButton: {
      setText() {},
      show() {},
      hide() {},
      onClick() {},
      offClick() {},
      showProgress() {},
      hideProgress() {},
    },
  },
}
