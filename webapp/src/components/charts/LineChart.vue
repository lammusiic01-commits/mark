<script setup>
import { computed } from 'vue'

const props = defineProps({
  values: { type: Array, default: () => [] },
  labels: { type: Array, default: () => [] },
  height: { type: Number, default: 140 },
  tone: { type: String, default: 'accent' },
  area: { type: Boolean, default: false },
})

const W = 320

const geometry = computed(() => {
  const v = props.values.map((x) => Number(x) || 0)
  if (v.length < 2) return null
  const max = Math.max(...v, 1)
  const pad = 8
  const h = props.height - 22
  const pts = v.map((y, i) => [
    pad + (i / (v.length - 1)) * (W - pad * 2),
    pad + (1 - y / max) * (h - pad * 2),
  ])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`
  return { line, area, max, h }
})

const color = computed(() => (props.tone === 'green' ? 'var(--green)' : 'var(--accent)'))
const ticks = computed(() => {
  const n = props.labels.length
  if (n < 2) return []
  const step = Math.max(1, Math.floor(n / 4))
  return props.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % step === 0 || i === n - 1)
})
</script>

<template>
  <div class="chart">
    <svg v-if="geometry" :viewBox="`0 0 ${W} ${height}`" width="100%" :height="height" preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="lc-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" :stop-color="color" stop-opacity="0.18" />
          <stop offset="100%" :stop-color="color" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line v-for="g in 3" :key="g" x1="0" :x2="W" :y1="(geometry.h / 3) * g" :y2="(geometry.h / 3) * g" stroke="var(--card-border)" stroke-width="1" />
      <path v-if="area" :d="geometry.area" fill="url(#lc-fill)" />
      <path :d="geometry.line" fill="none" :stroke="color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-else class="chart-empty muted small">Недостаточно данных для графика</div>
    <div v-if="ticks.length" class="ticks">
      <span v-for="t in ticks" :key="t.i" class="tick xs muted">{{ t.l }}</span>
    </div>
  </div>
</template>

<style scoped>
.chart { width: 100%; }
.chart-empty { height: 100px; display: flex; align-items: center; justify-content: center; }
.ticks { display: flex; justify-content: space-between; margin-top: 6px; }
.tick { font-variant-numeric: tabular-nums; }
</style>
