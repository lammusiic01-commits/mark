<script setup lang="ts">
import { press } from '../telegram';

/**
 * Кнопка приложения: варианты primary / glass / success / danger.
 * На нажатие отвечает тактильно — это часть ощущения системного приложения.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'glass' | 'success' | 'danger';
    size?: 'md' | 'sm' | 'icon';
    block?: boolean;
    disabled?: boolean;
    loading?: boolean;
  }>(),
  { variant: 'glass', size: 'md', block: false, disabled: false, loading: false },
);

const emit = defineEmits<{ (event: 'click'): void }>();

function onClick(): void {
  if (props.disabled || props.loading) return;
  press();
  emit('click');
}
</script>

<template>
  <button
    class="btn-glass"
    :class="[`btn-${variant}`, size === 'sm' ? 'btn-sm' : '', size === 'icon' ? 'btn-icon' : '', block ? 'btn-block' : '']"
    :disabled="disabled || loading"
    @click="onClick"
  >
    <span v-if="loading" class="spinner" />
    <slot />
  </button>
</template>
