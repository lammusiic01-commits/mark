<script setup lang="ts">
import { computed } from 'vue';

/** Линейный график по точкам: используется для динамики кликов и трафика. */
const props = withDefaults(defineProps<{ points: number[]; height?: number; color?: string }>(), {
  height: 84,
  color: '#0A84FF',
});

const width = 320;

const path = computed(() => {
  if (props.points.length < 2) return '';
  const max = Math.max(...props.points);
  const min = Math.min(...props.points);
  const span = max - min || 1;
  return props.points
    .map((value, index) => {
      const x = (index / (props.points.length - 1)) * width;
      const y = props.height - 8 - ((value - min) / span) * (props.height - 20);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

const area = computed(() => (path.value ? `${path.value} L${width},${props.height} L0,${props.height} Z` : ''));

const gradientId = `spark-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
  <svg class="chart" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img" aria-label="Динамика">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.35" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path v-if="area" :d="area" :fill="`url(#${gradientId})`" />
    <path v-if="path" :d="path" fill="none" :stroke="color" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
