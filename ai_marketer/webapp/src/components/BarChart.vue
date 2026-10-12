<template>
  <!-- График по дням: столбик — день, высота — доля подозрительных визитов -->
  <div class="chart">
    <div class="chart-bars">
      <div
        v-for="(point, index) in points"
        :key="point.date || index"
        class="bar-slot"
        :title="`${dayLabel(point.date)}: ${point.suspicious} из ${point.total}`"
      >
        <div class="bar" :style="{ height: `${heightOf(point)}%`, background: colorOf(point) }" />
      </div>
    </div>
    <div class="chart-axis">
      <span>{{ axisFrom }}</span>
      <span v-if="averageShare">в среднем {{ averageShare }} %</span>
      <span>{{ axisTo }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { dateShort } from '../composables/useFormat'

const props = defineProps({
  items: { type: Array, default: () => [] },
  warnAt: { type: Number, default: 15 }, // с этой доли столбик становится оранжевым
  dangerAt: { type: Number, default: 30 },
})

const points = computed(() => props.items.slice(-30))

const peak = computed(() => Math.max(1, ...points.value.map((point) => point.suspicious || 0)))

function heightOf(point) {
  const value = point.suspicious || 0
  return Math.max(4, Math.round((value / peak.value) * 100))
}

function shareOf(point) {
  if (typeof point.share === 'number') return point.share
  const total = point.total || 0
  return total ? Math.round(((point.suspicious || 0) / total) * 1000) / 10 : 0
}

function colorOf(point) {
  const share = shareOf(point)
  if (share >= props.dangerAt) return 'var(--accent-red)'
  if (share >= props.warnAt) return 'var(--accent-orange)'
  return 'var(--accent-blue)'
}

function dayLabel(value) {
  return dateShort(value)
}

const averageShare = computed(() => {
  const withData = points.value.filter((point) => (point.total || 0) > 0)
  if (!withData.length) return null
  const sum = withData.reduce((acc, point) => acc + shareOf(point), 0)
  return Math.round((sum / withData.length) * 10) / 10
})

const axisFrom = computed(() => (points.value[0] ? dateShort(points.value[0].date) : ''))
const axisTo = computed(() => (points.value.length ? dateShort(points.value[points.value.length - 1].date) : ''))
</script>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 108px;
  padding: 2px 0;
}

.bar-slot {
  flex: 1;
  min-width: 3px;
  height: 100%;
  display: flex;
  align-items: flex-end;
}

.bar {
  width: 100%;
  border-radius: 3px;
  opacity: 0.9;
  transition: height var(--duration-slow) var(--ease-ios);
}

.chart-axis {
  display: flex;
  justify-content: space-between;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}
</style>
