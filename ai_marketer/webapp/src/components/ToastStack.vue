<template>
  <!-- Всплывающие сообщения: сверху, над контентом, не перекрывают навигацию -->
  <transition-group name="toast" tag="div" class="toast-stack safe-top">
    <button
      v-for="toast in items"
      :key="toast.id"
      class="toast"
      :class="`toast-${toast.kind}`"
      type="button"
      @click="close(toast.id)"
    >
      <span class="toast-icon">{{ ICONS[toast.kind] || ICONS.info }}</span>
      <span class="toast-text">{{ toast.text }}</span>
    </button>
  </transition-group>
</template>

<script setup>
import { computed } from 'vue'
import { useAppStore } from '../store'
import { useHaptics } from '../composables/useHaptics'

const store = useAppStore()
const haptics = useHaptics()

const ICONS = {
  success: '✓',
  error: '!',
  info: 'i',
}

const items = computed(() => store.toasts)

function close(id) {
  haptics.light()
  store.dropToast(id)
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: calc(12px + env(safe-area-inset-top)) var(--space-4) 0;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: 420px;
  padding: 12px var(--space-4);
  border-radius: var(--radius-md);
  background: rgba(28, 28, 30, 0.94);
  -webkit-backdrop-filter:
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  text-align: left;
  pointer-events: auto;
}

.toast:active {
  transform: scale(0.98);
}

.toast-icon {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: var(--fw-bold);
  background: var(--surface-overlay);
}

.toast-success .toast-icon {
  background: rgba(48, 209, 88, 0.18);
  color: var(--accent-green);
}

.toast-error .toast-icon {
  background: rgba(255, 69, 58, 0.18);
  color: var(--accent-red);
}

.toast-info .toast-icon {
  background: rgba(10, 132, 255, 0.18);
  color: var(--accent-blue);
}

.toast-text {
  flex: 1;
  line-height: 1.35;
}

.toast-enter-active,
.toast-leave-active {
  transition: all var(--duration-normal) var(--ease-ios);
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(-16px) scale(0.96);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}
</style>
