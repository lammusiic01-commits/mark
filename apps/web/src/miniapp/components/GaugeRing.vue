<script setup lang="ts">
import { computed } from 'vue';

/** Кольцевой индикатор оценки (SEO-балл, чистота трафика). */
const props = withDefaults(defineProps<{ value: number; size?: number; label?: string; color?: string }>(), {
  size: 96,
  label: '',
  color: '',
});

const radius = computed(() => props.size / 2 - 7);
const circumference = computed(() => 2 * Math.PI * radius.value);
const offset = computed(() => circumference.value * (1 - Math.min(Math.max(props.value, 0), 100) / 100));
const stroke = computed(() => props.color || (props.value >= 80 ? '#30D158' : props.value >= 60 ? '#FF9F0A' : '#FF453A'));
</script>

<template>
  <div class="orb-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img" :aria-label="`Оценка ${value} из 100`">
      <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="7" />
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        :stroke="stroke"
        stroke-width="7"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="offset"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        style="transition: stroke-dashoffset 600ms cubic-bezier(0.32, 0.72, 0, 1)"
      />
    </svg>
    <div style="position: absolute; inset: 0; display: grid; place-items: center">
      <div style="text-align: center">
        <div style="font-size: 24px; font-weight: 700; letter-spacing: -0.6px">{{ Math.round(value) }}</div>
        <div v-if="label" class="mini-hint">{{ label }}</div>
      </div>
    </div>
  </div>
</template>
