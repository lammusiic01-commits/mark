<script setup>
// Площадь с заливкой — тот же SVG, что LineChart с area=true.
import LineChart from './LineChart.vue'
defineProps({
  values: { type: Array, default: () => [] },
  labels: { type: Array, default: () => [] },
  height: { type: Number, default: 140 },
  tone: { type: String, default: 'accent' },
})
</script>

<template>
  <LineChart :values="values" :labels="labels" :height="height" :tone="tone" area />
</template>
