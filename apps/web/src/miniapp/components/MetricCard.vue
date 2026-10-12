<script setup lang="ts">
/** Плитка метрики: значение, подпись и изменение относительно прошлого периода. */
const props = withDefaults(
  defineProps<{ label: string; value: string; delta?: number | null; deltaSuffix?: string; suffix?: string }>(),
  { delta: null, deltaSuffix: '%', suffix: '' },
);

const deltaClass = (): string => {
  if (props.delta === null || props.delta === undefined || props.delta === 0) return 'delta-flat';
  return props.delta > 0 ? 'delta-up' : 'delta-down';
};

const deltaText = (): string => {
  if (props.delta === null || props.delta === undefined) return '';
  const sign = props.delta > 0 ? '+' : '';
  return `${sign}${props.delta}${props.deltaSuffix}`;
};
</script>

<template>
  <div class="metric">
    <span class="metric-label">{{ label }}</span>
    <span class="metric-value">{{ value }}<small v-if="suffix" class="mini-hint"> {{ suffix }}</small></span>
    <span v-if="delta !== null && delta !== undefined" class="metric-delta" :class="deltaClass()">{{ deltaText() }} к прошлой неделе</span>
  </div>
</template>
