<script setup>
import { computed } from 'vue'

const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 88 },
  height: { type: Number, default: 28 },
  tone: { type: String, default: 'accent' },
})

const path = computed(() => {
  const v = props.values.map(Number)
  if (v.length < 2) return ''
  const max = Math.max(...v, 1)
  const min = Math.min(...v, 0)
  const span = max - min || 1
  return v.map((y, i) => {
    const x = (i / (v.length - 1)) * props.width
    const yy = props.height - ((y - min) / span) * (props.height - 4) - 2
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yy.toFixed(1)}`
  }).join(' ')
})
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true">
    <path v-if="path" :d="path" fill="none" :stroke="tone === 'green' ? 'var(--green)' : 'var(--accent-hover)'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
