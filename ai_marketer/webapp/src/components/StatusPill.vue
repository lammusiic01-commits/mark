<template>
  <!-- Статус коротко: включена, на паузе, черновик, архив -->
  <span class="pill" :class="`pill-${tone}`">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, default: '' },
})

const MAP = {
  active: { label: 'Работает', tone: 'green' },
  paused: { label: 'Пауза', tone: 'orange' },
  draft: { label: 'Черновик', tone: 'gray' },
  archived: { label: 'Архив', tone: 'gray' },
  pending: { label: 'Ждёт решения', tone: 'blue' },
  applied: { label: 'В работе', tone: 'green' },
  rejected: { label: 'Отклонена', tone: 'gray' },
  paid: { label: 'Оплачен', tone: 'green' },
  failed: { label: 'Истёк', tone: 'red' },
  connected: { label: 'Подключено', tone: 'green' },
  disconnected: { label: 'Не подключено', tone: 'gray' },
  error: { label: 'Ошибка', tone: 'red' },
}

const config = computed(() => MAP[props.status] || { label: props.status || '—', tone: 'gray' })
const label = computed(() => config.value.label)
const tone = computed(() => config.value.tone)
</script>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.pill-green {
  background: rgba(48, 209, 88, 0.14);
  color: var(--accent-green);
}

.pill-orange {
  background: rgba(255, 159, 10, 0.14);
  color: var(--accent-orange);
}

.pill-red {
  background: rgba(255, 69, 58, 0.14);
  color: var(--accent-red);
}

.pill-blue {
  background: rgba(10, 132, 255, 0.14);
  color: var(--accent-blue);
}

.pill-gray {
  background: var(--surface-overlay);
  color: var(--text-secondary);
}
</style>
