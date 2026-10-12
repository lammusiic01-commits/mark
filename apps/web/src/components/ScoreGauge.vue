<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ value: number; label?: string; size?: number; invert?: boolean }>(), { label: 'Балл', size: 132 });

const tone = computed(() => {
  const value = props.invert ? 100 - props.value : props.value;
  if (value >= 80) return '#22c55e';
  if (value >= 60) return '#a3e635';
  if (value >= 40) return '#f59e0b';
  return '#ef4444';
});

const circumference = 2 * Math.PI * 52;
const dash = computed(() => (Math.max(0, Math.min(100, props.value)) / 100) * circumference);
</script>

<template>
  <div class="gauge" :style="{ width: `${size}px` }">
    <svg viewBox="0 0 120 120" :width="size" :height="size">
      <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="11" />
      <circle
        cx="60"
        cy="60"
        r="52"
        fill="none"
        :stroke="tone"
        stroke-width="11"
        stroke-linecap="round"
        :stroke-dasharray="`${dash} ${circumference}`"
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="57" text-anchor="middle" fill="#e8eefc" font-size="26" font-weight="700">{{ Math.round(value) }}</text>
      <text x="60" y="76" text-anchor="middle" fill="#6b7a9d" font-size="11">из 100</text>
    </svg>
    <div class="gauge-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.gauge-label {
  font-size: 12.5px;
  color: var(--text-dim);
  text-align: center;
}
</style>
