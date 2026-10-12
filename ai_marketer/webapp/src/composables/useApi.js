/*
  Обмен с сервером. Правила:
   • адрес API только относительный ('/api'): страница не знает про localhost,
     в разработке запрос проксирует vite, в проде — тот же origin или nginx;
   • каждая заявка несёт заголовок X-Telegram-Init-Data — по нему сервер
     понимает, кто пришёл (без него API отвечает 401);
   • ошибку всегда превращаем в понятный текст: пользователь видит причину,
     а не «HTTP 500».
*/
const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const DEV_KEY = 'ai_marketer_init_data'
const TIMEOUT_MS = 60_000

/** Строка входа: сначала из Telegram, затем сохранённая для проверки в браузере. */
export function accessToken() {
  const fromTelegram = window.Telegram?.WebApp?.initData
  if (fromTelegram) return fromTelegram
  try {
    return localStorage.getItem(DEV_KEY) || ''
  } catch {
    return ''
  }
}

export function saveAccessToken(initData) {
  try {
    localStorage.setItem(DEV_KEY, initData || '')
  } catch {
    /* приватный режим браузера — просто не сохраняем */
  }
}

export function hasAccess() {
  return Boolean(accessToken())
}

/**
 * Вход для проверки в браузере: если открыто вне Telegram и нет сохранённой
 * строки входа, просим у сервера тестовую (доступна только в режиме
 * разработки — в боевом режиме сервер отвечает 404 и мы ничего не подставляем).
 */
export async function ensureAccess() {
  if (hasAccess()) return true
  if (!import.meta.env.DEV) return false
  try {
    const response = await fetch(`${API_BASE}/dev/sign-in`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return false
    const data = await response.json()
    if (data?.init_data) {
      saveAccessToken(data.init_data)
      return true
    }
  } catch {
    /* сервер недоступен — покажем экран «нет связи» */
  }
  return false
}

function describe(error, response) {
  if (response) {
    if (response.status === 401) return 'Вход устарел — откройте приложение заново из бота'
    if (response.status === 403) return 'Доступ закрыт. Напишите в поддержку'
    if (response.status === 404) return 'Не найдено'
    if (response.status === 502) return 'Внешний сервис не ответил — попробуйте позже'
    if (response.status >= 500) return 'Ошибка на сервере — мы уже смотрим логи'
  }
  if (error?.name === 'AbortError') return 'Долгий ответ — проверьте связь и повторите'
  return error?.message || 'Не удалось выполнить запрос'
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Telegram-Init-Data': accessToken(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { detail: text.slice(0, 300) }
      }
    }

    if (!response.ok) {
      const detail = payload?.detail
      const message =
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail) && detail[0]?.msg
            ? detail[0].msg
            : describe(null, response)
      const error = new Error(message)
      error.status = response.status
      error.payload = payload
      throw error
    }

    return payload
  } catch (error) {
    if (error.status) throw error
    const wrapped = new Error(describe(error))
    wrapped.cause = error
    throw wrapped
  } finally {
    clearTimeout(timer)
  }
}

export function useApi() {
  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
    request,
  }
}

/** Адрес для картинки QR: <img> не умеет отправлять заголовки авторизации. */
export function qrSrc(base64) {
  return base64 ? `data:image/png;base64,${base64}` : ''
}
