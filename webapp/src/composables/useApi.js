/**
 * API-клиент Mini App. КАЖДЫЙ запрос несёт initData в заголовке X-Telegram-Init-Data:
 * сервер проверяет подпись HMAC-SHA256 и только после этого отдаёт данные пользователя.
 */
const API_BASE = '/api'

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function initData() {
  return window.Telegram?.WebApp?.initData || ''
}

function messageFrom(body, status) {
  const detail = body?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join('; ')
  return `Ошибка ${status}`
}

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData(),
        ...(options.headers || {}),
      },
    })
  } catch (_) {
    throw new ApiError('Нет связи с сервером. Проверь подключение и попробуй снова.', 0)
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(messageFrom(body, res.status), res.status)
  return body
}

export const api = {
  get: (path) => request(path),
  post: (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  put: (path, body = {}) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: (path) => request(path, { method: 'DELETE' }),
}

export function useApi() {
  return api
}
