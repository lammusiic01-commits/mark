<template>
  <button
    class="g-btn"
    :class="[`variant-${variant}`, `size-${size}`, { 'full-width': block }]"
    :disabled="disabled || loading"
    @click="handleClick"
  >
    <span v-if="loading" class="spinner" />
    <slot v-else />
  </button>
</template>

<script setup>
import { useHaptics } from '../composables/useHaptics'

const props = defineProps({
  variant: { type: String, default: 'primary' }, // primary / secondary / ghost / danger
  size:    { type: String, default: 'md' },      // sm / md / lg
  block:   Boolean,
  loading: Boolean,
  disabled: Boolean,
})
const emit = defineEmits(['click'])
const h = useHaptics()

function handleClick(e) {
  h.light()
  emit('click', e)
}
</script>

<style scoped>
.g-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-family: var(--font-text);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
  border-radius: var(--radius-pill);
  transition: all var(--duration-fast) var(--ease-spring);
  position: relative;
  overflow: hidden;
}

.g-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.g-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Sizes */
.size-sm { padding: 10px 16px; font-size: var(--fs-footnote); }
.size-md { padding: 14px 22px; font-size: var(--fs-body); }
.size-lg { padding: 18px 28px; font-size: var(--fs-headline); }

.full-width { width: 100%; }

/* Variants */
.variant-primary {
  background: var(--text-primary);
  color: var(--bg-primary);
}
.variant-primary:active:not(:disabled) {
  background: #D4D4D4;
}

.variant-secondary {
  background: var(--surface-overlay);
  color: var(--text-primary);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-subtle);
}
.variant-secondary:active:not(:disabled) {
  background: var(--surface-overlay-hover);
}

.variant-ghost {
  background: transparent;
  color: var(--accent-blue);
}

.variant-danger {
  background: var(--accent-red);
  color: #fff;
}

.spinner {
  width: 18px; height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
