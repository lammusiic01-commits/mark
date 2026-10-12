<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 }, // 0..100
  label: { type: String, default: '' },
  size: { type: Number, default: 140 },
})

const R = 52
const HALF = Math.PI * R
const clamped = computed(() => Math.max(0, Math.min(100, props.value)))
const dash = computed(() => `${(clamped.value / 100) * HALF} ${HALF}`)
const color = computed(() => {
  if (clamped.value >= 70) return 'var(--green)'
  if (clamped.value >= 40) return 'var(--amber)'
  return 'var(--red)'
})
</script>

<template>
  <div class="gauge" :style="{ width: size + 'px' }">
    <svg viewBox="0 0 140 84" width="100%" role="img" :aria-label="`${clamped} из 100`">
      <path d="M18,70 A52,52 0 0 1 122,70" fill="none" stroke="var(--bg-elevated)" stroke-width="12" stroke-linecap="round" />
      <path d="M18,70 A52,52 0 0 1 122,70" fill="none" :stroke="color" stroke-width="12" stroke-linecap="round" :stroke-dasharray="dash" />
    </svg>
    <div class="gauge-value num">{{ Math.round(clamped) }}</div>
    <div class="xs muted">{{ label }}</div>
  </div>
</template>

<style scoped>
.gauge { display: flex; flex-direction: column; align-items: center; position: relative; }
.gauge-value { font-size: var(--text-2xl); font-weight: 600; margin-top: -34px; }
</style>
