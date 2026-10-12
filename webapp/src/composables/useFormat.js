const ru = new Intl.NumberFormat('ru-RU')

/** Копейки → «1 234 ₽». digits — сколько знаков после запятой показать */
export function rub(kop, digits = 0) {
  if (kop === null || kop === undefined) return '—'
  const value = Number(kop) / 100
  const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
  return `${fmt.format(value)} ₽`
}

/** Рубли (уже в ₽) → строка с валютой */
export function rubs(value, digits = 0) {
  if (value === null || value === undefined) return '—'
  const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
  return `${fmt.format(Number(value))} ₽`
}

export function num(value) {
  if (value === null || value === undefined) return '—'
  return ru.format(Number(value))
}

export function pct(value, digits = 2) {
  if (value === null || value === undefined) return '—'
  return `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits })}%`
}

/** 2026-10-12 → 12.10 */
export function shortDate(iso) {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${d}.${m}`
}

/** 2026-10-12 → 12.10.2026 */
export function fullDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

export function dateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function delta(value) {
  if (value === null || value === undefined) return { text: '—', tone: 'muted' }
  const sign = value > 0 ? '+' : ''
  return { text: `${sign}${value}%`, tone: value > 0 ? 'pos' : value < 0 ? 'neg' : 'muted' }
}

export const ACTION_LABEL = {
  pause: 'Пауза',
  decrease_bid: 'Снизить ставку',
  increase_bid: 'Поднять ставку',
  keep: 'Без изменений',
}

export const STATUS_LABEL = {
  ON: 'Активна',
  ACTIVE: 'Активна',
  SUSPENDED: 'Приостановлена',
  OFF: 'Выключена',
  ENDED: 'Завершена',
  ARCHIVED: 'В архиве',
}

export const VERDICT_LABEL = { low: 'Низкий риск', medium: 'Средний риск', high: 'Высокий риск' }
export const VERDICT_TONE = { low: 'badge-green', medium: 'badge-amber', high: 'badge-red' }
