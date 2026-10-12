/*
  Форматирование чисел и дат по-русски.
  Везде используется Intl.NumberFormat('ru-RU') — так суммы и проценты
  выглядят привычно (пробелы между разрядами, запятая в дробях), а не как
  «1234.5».
*/
const nfMoney = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const nfMoneyExact = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nfNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const nfDecimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const nfPercent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

const nfCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 })

/** 1 234 ₽ — основная форма суммы. */
export function money(value, withCurrency = true) {
  const number = Number(value || 0)
  const text = Number.isInteger(number) ? nfMoney.format(number) : nfMoneyExact.format(number)
  return withCurrency ? `${text} ₽` : text
}

/** Коротко: 12,3 тыс. ₽ — для мест, где мало ширины. */
export function moneyShort(value) {
  const number = Number(value || 0)
  if (Math.abs(number) < 10000) return money(number)
  return `${nfCompact.format(number)} ₽`
}

/** Число с разрядами: 1 234. */
export function number(value) {
  return nfNumber.format(Number(value || 0))
}

/** Проценты: 18,4 %. */
export function percent(value, withSign = false) {
  const number = Number(value || 0)
  const sign = withSign && number > 0 ? '+' : ''
  return `${sign}${nfPercent.format(number)} %`
}

/** Доля от целого: доля 0…1 или уже проценты. */
export function share(value) {
  const number = Number(value || 0)
  const percents = number <= 1 ? number * 100 : number
  return `${nfPercent.format(percents)} %`
}

/** Цена клика: 58,40 ₽. */
export function moneyExact(value) {
  return `${nfMoneyExact.format(Number(value || 0))} ₽`
}

/** Склонение: 1 клик / 2 клика / 5 кликов. */
export function plural(count, one, few, many) {
  const number = Math.abs(Number(count || 0)) % 100
  const last = number % 10
  if (number > 10 && number < 20) return many
  if (last > 1 && last < 5) return few
  if (last === 1) return one
  return many
}

/** «1 234 клика» — число сразу с правильной формой слова. */
export function withPlural(count, one, few, many) {
  return `${number(count)} ${plural(count, one, few, many)}`
}

function parse(value) {
  if (!value) return null
  if (value instanceof Date) return value
  const date = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

/** 12 окт — короткая дата. */
export function dateShort(value) {
  const date = parse(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(date).replace('.', '')
}

/** 12 октября 2026. */
export function dateLong(value) {
  const date = parse(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
}

/** «сегодня, 14:35» / «вчера» / «12 окт» — для списков операций и отчётов. */
export function dateHuman(value) {
  const date = parse(value)
  if (!date) return '—'
  const today = new Date()
  const sameDay = (a, b) => a.toDateString() === b.toDateString()
  const yesterday = new Date(today.getTime() - 86400000)

  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date)
  if (sameDay(date, today)) return `сегодня, ${time}`
  if (sameDay(date, yesterday)) return `вчера, ${time}`
  return `${dateShort(date)}, ${time}`
}

/** Сколько прошло: «3 минуты назад». */
export function timeAgo(value) {
  const date = parse(value)
  if (!date) return '—'
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'только что'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  return dateShort(date)
}

/** Знак изменения: +12,4 % / −3,1 %. */
export function deltaText(value) {
  const number = Number(value || 0)
  if (!number) return '0 %'
  const sign = number > 0 ? '+' : '−'
  return `${sign}${nfPercent.format(Math.abs(number))} %`
}

export function decimal(value) {
  return nfDecimal.format(Number(value || 0))
}

export function useFormat() {
  return {
    money,
    moneyShort,
    moneyExact,
    number,
    percent,
    share,
    plural,
    withPlural,
    dateShort,
    dateLong,
    dateHuman,
    timeAgo,
    deltaText,
    decimal,
  }
}
