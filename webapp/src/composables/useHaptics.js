import { tg } from './useTelegram.js'

/** Тактильный отклик: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' */
export function haptic(style = 'light') {
  try { tg?.HapticFeedback?.impactOccurred(style) } catch (_) { /* браузер */ }
}

/** Уведомительная вибрация: 'success' | 'warning' | 'error' */
export function hapticNotify(type = 'success') {
  try { tg?.HapticFeedback?.notificationOccurred(type) } catch (_) { /* браузер */ }
}

export function useHaptics() {
  return { haptic, hapticNotify, selection: () => { try { tg?.HapticFeedback?.selectionChanged() } catch (_) { /* */ } } }
}
