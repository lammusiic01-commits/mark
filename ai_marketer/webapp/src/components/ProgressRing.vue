<template>
  <!-- Круговой индикатор: показывает долю (риск ботов, оценка сайта) -->
  <div class="ring" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :viewBox="`0 0 ${size} ${size}`" class="ring-svg">
      <circle class="ring-track" :cx="center" :cy="center" :r="radius" :stroke-width="stroke" />
      <circle
        class="ring-value"
        :cx="center"
        :cy="center"
        :r="radius"
        :stroke-width="stroke"
        :stroke="color"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="offset"
      />
    </svg>
    <div class="ring-body">
      <slot>
        <span class="ring-number">{{ display }}</span>
        <span v-if="caption" class="ring-caption">{{ caption }}</span>
      </slot>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 }, // 0…100
  size: { type: Number, default: 168 },
  stroke: { type: Number, default: 12 },
  color: { type: String, default: 'var(--accent-blue)' },
  caption: { type: String, default: '' },
  animate: { type: Boolean, default: true },
})

const center = computed(() => props.size / 2)
const radius = computed(() => props.size / 2 - props.stroke / 2 - 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const display = computed(() => Math.round(Math.min(100, Math.max(0, props.value))))

const offset = computed(() => {
  const share = Math.min(100, Math.max(0, props.value)) / 100
  return circumference.value * (1 - share)
})
</script>

<style scoped>
.ring {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.ring-track {
  fill: none;
  stroke: var(--surface-overlay);
}

.ring-value {
  fill: none;
  stroke-linecap: round;
  transition: stroke-dashoffset var(--duration-slow) var(--ease-ios);
}

.ring-body {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.ring-number {
  font-family: var(--font-display);
  font-size: var(--fs-large);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
  line-height: 1;
}

.ring-caption {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
