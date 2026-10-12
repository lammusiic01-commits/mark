<template>
  <!-- Строка настроек: иконка, заголовок, пояснение, значение, действие -->
  <component
    :is="clickable ? 'button' : 'div'"
    class="row"
    :class="{ clickable }"
    :type="clickable ? 'button' : undefined"
    @click="onClick"
  >
    <span v-if="icon" class="row-icon">{{ icon }}</span>

    <span class="row-body">
      <span class="row-title">{{ title }}</span>
      <span v-if="subtitle" class="row-subtitle">{{ subtitle }}</span>
    </span>

    <span v-if="value" class="row-value" :class="{ danger }">{{ value }}</span>

    <span v-if="clickable" class="row-chevron">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  </component>
</template>

<script setup>
import { useHaptics } from '../composables/useHaptics'

const props = defineProps({
  icon: { type: String, default: '' },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  value: { type: String, default: '' },
  danger: { type: Boolean, default: false },
  clickable: { type: Boolean, default: false },
  haptic: { type: String, default: 'light' },
})

const emit = defineEmits(['click'])
const haptics = useHaptics()

function onClick() {
  if (!props.clickable) return
  haptics[props.haptic]?.() || haptics.light()
  emit('click')
}
</script>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: 14px var(--space-4);
  background: none;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  text-align: left;
}

.row:last-child {
  border-bottom: none;
}

.row.clickable {
  transition: background var(--duration-fast) var(--ease-ios);
}

.row.clickable:active {
  background: var(--surface-overlay);
}

.row-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  background: var(--surface-overlay);
}

.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-title {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
}

.row-subtitle {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.35;
}

.row-value {
  flex: none;
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-value.danger {
  color: var(--accent-red);
}

.row-chevron {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--text-tertiary);
}

.row-chevron svg {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
