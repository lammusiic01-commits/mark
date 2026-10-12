<template>
  <GlassCard class="metric">
    <div class="metric-head">
      <span class="metric-icon" :style="{ background: color }">{{ icon }}</span>
      <span class="metric-label">{{ label }}</span>
    </div>
    <div class="metric-value">
      {{ value }}
      <span v-if="unit" class="metric-unit">{{ unit }}</span>
    </div>
    <div v-if="change !== undefined" class="metric-change" :class="changeClass">
      {{ change >= 0 ? '↑' : '↓' }} {{ Math.abs(change) }}%
    </div>
  </GlassCard>
</template>

<script setup>
import { computed } from 'vue'
import GlassCard from './GlassCard.vue'

const props = defineProps({
  icon: String,
  label: String,
  value: [String, Number],
  unit: String,
  change: Number,
  color: { type: String, default: 'rgba(10, 132, 255, 0.15)' },
})

const changeClass = computed(() => {
  if (props.change > 0) return 'positive'
  if (props.change < 0) return 'negative'
  return 'neutral'
})
</script>

<style scoped>
.metric { padding: var(--space-4); }

.metric-head {
  display: flex; align-items: center; gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.metric-icon {
  width: 32px; height: 32px;
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
}

.metric-label {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  font-weight: var(--fw-medium);
}

.metric-value {
  font-family: var(--font-display);
  font-size: var(--fs-title-1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
  line-height: 1;
}

.metric-unit {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
  margin-left: 2px;
}

.metric-change {
  margin-top: var(--space-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}
.positive { color: var(--accent-green); }
.negative { color: var(--accent-red); }
.neutral  { color: var(--text-tertiary); }
</style>
