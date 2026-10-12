<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ status?: string | null; label?: string }>();

const MAP: Record<string, { variant: string; text: string }> = {
  valid: { variant: 'success', text: 'Работает' },
  pass: { variant: 'success', text: 'Проверка пройдена' },
  done: { variant: 'success', text: 'Готово' },
  sent: { variant: 'success', text: 'Отправлено' },
  active: { variant: 'success', text: 'Активна' },
  human: { variant: 'success', text: 'Человек' },
  good_bot: { variant: 'success', text: 'Поисковый бот' },
  unchecked: { variant: 'neutral', text: 'Не проверено' },
  validating: { variant: 'info', text: 'Проверяется…' },
  running: { variant: 'info', text: 'Выполняется…' },
  queued: { variant: 'info', text: 'В очереди' },
  building: { variant: 'info', text: 'Формируется' },
  waiting_user: { variant: 'info', text: 'Ждём вход' },
  captured: { variant: 'info', text: 'Сессия получена' },
  backlog: { variant: 'neutral', text: 'В бэклоге' },
  planned: { variant: 'neutral', text: 'Запланировано' },
  paused: { variant: 'warn', text: 'На паузе' },
  warn: { variant: 'warn', text: 'Замечания' },
  expired: { variant: 'warn', text: 'Истекает' },
  awaiting_approval: { variant: 'warn', text: 'Ждёт подтверждения' },
  ai_crawler: { variant: 'info', text: 'AI-краулер' },
  headless: { variant: 'warn', text: 'Headless-браузер' },
  bot: { variant: 'warn', text: 'Бот' },
  scraper: { variant: 'warn', text: 'Скрапер' },
  attack: { variant: 'danger', text: 'Атака' },
  ddos: { variant: 'danger', text: 'DDoS' },
  invalid: { variant: 'danger', text: 'Не работает' },
  failed: { variant: 'danger', text: 'Ошибка' },
  fail: { variant: 'danger', text: 'Не прошла' },
  closed: { variant: 'neutral', text: 'Закрыта' },
  ended: { variant: 'neutral', text: 'Завершена' },
  rejected: { variant: 'neutral', text: 'Отклонена' },
  archived: { variant: 'neutral', text: 'В архиве' },
  none: { variant: 'neutral', text: 'Не настроено' },
  applied: { variant: 'success', text: 'Применено' },
  no_difference: { variant: 'neutral', text: 'Без разницы' },
  winner: { variant: 'success', text: 'Победитель' },
  insufficient_data: { variant: 'warn', text: 'Мало данных' },
  draft: { variant: 'neutral', text: 'Черновик' },
  skipped: { variant: 'neutral', text: 'Пропущено' },
};

const resolved = computed(() => {
  const key = String(props.status ?? '');
  const fallback = { variant: 'neutral', text: props.label ?? key ?? '—' };
  const entry = MAP[key] ?? fallback;
  return { variant: entry.variant, text: props.label ?? entry.text };
});
</script>

<template>
  <span class="pill" :class="resolved.variant">{{ resolved.text }}</span>
</template>
