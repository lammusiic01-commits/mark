<script setup>
defineProps({
  variant: { type: String, default: 'default' }, // default | primary | ghost | danger
  size: { type: String, default: 'md' },         // md | sm
  loading: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})
defineEmits(['click'])
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[
      variant === 'primary' && 'btn-primary',
      variant === 'ghost' && 'btn-ghost',
      variant === 'danger' && 'btn-danger',
      size === 'sm' && 'btn-sm',
      block && 'btn-block',
    ]"
    :disabled="disabled || loading"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
