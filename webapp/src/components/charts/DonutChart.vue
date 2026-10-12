<script setup>
import { computed } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] }, // [{ label, value, color }]
  size: { type: Number, default: 120 },
  centerLabel: { type: String, default: '' },
  centerValue: { type: String, default: '' },
})

const R = 46
const C = 2 * Math.PI * R

const segments = computed(() => {
  const total = props.items.reduce((s, i) => s + (Number(i.value) || 0), 0)
  if (!total) return []
  let offset = 0
  return props.items.map((i) => {
    const len = ((Number(i.value) || 0) / total) * C
    const seg = { ...i, dash: `${len} ${C - len}`, offset: -offset }
    offset += len
    return seg
  })
})
</script>

<template>
  <div class="donut">
    <svg :width="size" :height="size" viewBox="0 0 120 120" role="img">
      <circle cx="60" cy="60" :r="R" fill="none" stroke="var(--bg-elevated)" stroke-width="12" />
      <circle
        v-for="(s, idx) in segments"
        :key="idx"
        cx="60" cy="60" :r="R" fill="none" :stroke="s.color" stroke-width="12"
        :stroke-dasharray="s.dash" :stroke-dashoffset="s.offset"
        transform="rotate(-90 60 60)"
      />
    </svg>
    <div class="donut-center">
      <div class="num donut-value">{{ centerValue }}</div>
      <div class="xs muted">{{ centerLabel }}</div>
    </div>
  </div>
</template>

<style scoped>
.donut { position: relative; width: 120px; height: 120px; }
.donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.donut-value { font-weight: 600; font-size: var(--text-lg); }
</style>
