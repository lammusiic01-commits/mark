<template>
  <!-- Шапка экрана: заголовок, возврат, действие справа -->
  <header class="screen-header safe-top">
    <button v-if="back" class="icon-btn" type="button" aria-label="Назад" @click="goBack">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>

    <div class="titles">
      <span v-if="eyebrow" class="eyebrow">{{ eyebrow }}</span>
      <h1 class="title">{{ title }}</h1>
    </div>

    <button v-if="$slots.action" class="action" type="button" @click="onAction">
      <slot name="action" />
    </button>
    <span v-else-if="!back" class="spacer" />
  </header>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useHaptics } from '../composables/useHaptics'

const props = defineProps({
  title: { type: String, required: true },
  eyebrow: { type: String, default: '' },
  back: { type: Boolean, default: false },
  fallbackPath: { type: String, default: '/' },
})

const emit = defineEmits(['action'])
const router = useRouter()
const haptics = useHaptics()

function goBack() {
  haptics.light()
  // Если истории нет (приложение открыто сразу на этой странице) — идём домой
  if (window.history.length > 1) router.back()
  else router.push(props.fallbackPath)
}

function onAction() {
  haptics.light()
  emit('action')
}
</script>

<style scoped>
.screen-header {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: calc(10px + env(safe-area-inset-top)) var(--space-4) 10px;
  background: rgba(10, 10, 10, 0.78);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid var(--border-subtle);
}

.titles {
  flex: 1;
  min-width: 0;
}

.eyebrow {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 2px;
}

.title {
  font-size: var(--fs-title-2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-btn {
  flex: none;
  width: 36px;
  height: 36px;
  padding: 8px;
  border-radius: 50%;
  color: var(--text-primary);
  background: var(--surface-overlay);
  transition: transform var(--duration-fast) var(--ease-spring), background var(--duration-fast) var(--ease-ios);
}

.icon-btn svg {
  width: 100%;
  height: 100%;
  display: block;
}

.icon-btn:active {
  transform: scale(0.9);
  background: var(--surface-overlay-hover);
}

.action {
  flex: none;
  min-height: 36px;
  padding: 8px 14px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  color: var(--accent-blue);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  transition: transform var(--duration-fast) var(--ease-spring);
}

.action:active {
  transform: scale(0.94);
}

.spacer {
  width: 36px;
}
</style>
