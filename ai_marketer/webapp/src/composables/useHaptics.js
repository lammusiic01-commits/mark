export function useHaptics() {
  const tg = window.Telegram?.WebApp
  const h = tg?.HapticFeedback

  return {
    light:   () => h?.impactOccurred?.('light'),
    medium:  () => h?.impactOccurred?.('medium'),
    heavy:   () => h?.impactOccurred?.('heavy'),
    rigid:   () => h?.impactOccurred?.('rigid'),
    soft:    () => h?.impactOccurred?.('soft'),
    success: () => h?.notificationOccurred?.('success'),
    warning: () => h?.notificationOccurred?.('warning'),
    error:   () => h?.notificationOccurred?.('error'),
    select:  () => h?.selectionChanged?.(),
  }
}
