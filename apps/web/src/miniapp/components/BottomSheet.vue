<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { select } from '../telegram';

/**
 * Нижняя шторка в стиле iOS: затемнение фона, плавный подъём,
 * свайп-закрытие кнопкой и по фону.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (event: 'close'): void }>();

function close(): void {
  select();
  emit('close');
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

watch(
  () => props.open,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) window.addEventListener('keydown', onKey);
    else window.removeEventListener('keydown', onKey);
  },
);

onBeforeUnmount(() => {
  document.body.style.overflow = '';
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-backdrop" @click="close" />
    <div v-if="open" class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grabber" />
      <slot />
    </div>
  </Teleport>
</template>
