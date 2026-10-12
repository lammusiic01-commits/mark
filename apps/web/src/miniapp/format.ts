/** Мелкие форматтеры мини-приложения: рубли, числа, даты, цвета статусов. */

export function money(value: number | null | undefined, options: { compact?: boolean } = {}): string {
  const amount = Number(value ?? 0);
  if (options.compact && Math.abs(amount) >= 1000) {
    if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace('.0', '')} млн ₽`;
    return `${Math.round(amount / 1000)} тыс ₽`;
  }
  return `${Math.round(amount).toLocaleString('ru-RU')} ₽`;
}

export function num(value: number | null | undefined): string {
  return Math.round(Number(value ?? 0)).toLocaleString('ru-RU');
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return 'ещё не запускалось';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function dayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function percent(value: number | null | undefined, digits = 1): string {
  return `${Number(value ?? 0).toFixed(digits).replace('.0', '')}%`;
}

/** Цвет по уровню проблемы — одинаковый во всех экранах. */
export function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return '#FF453A';
    case 'high':
      return '#FF9F0A';
    case 'medium':
      return '#0A84FF';
    case 'low':
      return '#30D158';
    default:
      return 'rgba(235,235,245,0.6)';
  }
}

export function severityLabel(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'критично';
    case 'high':
      return 'важно';
    case 'medium':
      return 'средне';
    case 'low':
      return 'мелочь';
    default:
      return 'инфо';
  }
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: 'работает',
    paused: 'пауза',
    draft: 'черновик',
    ended: 'завершена',
    running: 'идёт',
    backlog: 'в очереди',
    planned: 'запланирована',
    done: 'готово',
    rejected: 'отклонена',
    valid: 'подключено',
    invalid: 'ошибка',
    disconnected: 'не подключено',
    pending: 'ожидает',
    paid: 'оплачено',
    failed: 'ошибка',
    expired: 'истёк',
    not_started: 'не начато',
  };
  return labels[status] ?? status;
}

export function statusVariant(status: string): string {
  if (['active', 'running', 'valid', 'done', 'paid'].includes(status)) return 'badge-live';
  if (['paused', 'backlog', 'planned', 'pending', 'not_started'].includes(status)) return 'badge-warn';
  if (['invalid', 'failed', 'expired', 'rejected'].includes(status)) return 'badge-danger';
  return '';
}

export function planScore(ice: { score?: number } | null | undefined): string {
  return Math.round(Number(ice?.score ?? 0)).toString();
}
