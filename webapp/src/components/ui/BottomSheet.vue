<script setup>
import { watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

function close() {
  emit('update:modelValue', false)
}

function onKey(e) {
  if (e.key === 'Escape') close()
}

watch(() => props.modelValue, (open) => {
  if (open) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="modelValue" class="sheet-overlay" @click.self="close">
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet-handle" aria-hidden="true"></div>
          <div class="row-between sheet-head">
            <div class="sheet-title">{{ title }}</div>
            <button class="btn btn-ghost btn-icon" aria-label="Закрыть" @click="close"><Icon name="x" :size="16" /></button>
          </div>
          <div class="sheet-body"><slot /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.sheet {
  width: 100%; max-height: 88vh; overflow: auto; background: var(--bg-surface);
  border: 1px solid var(--card-border); border-bottom: 0;
  border-radius: var(--r-lg) var(--r-lg) 0 0; padding: 8px var(--s-4) calc(var(--s-6) + env(safe-area-inset-bottom));
}
.sheet-handle { width: 36px; height: 4px; border-radius: 2px; background: var(--bg-elevated); margin: 0 auto var(--s-3); }
.sheet-head { margin-bottom: var(--s-3); }
.sheet-title { font-weight: 600; font-size: var(--text-lg); }
.sheet-body { display: flex; flex-direction: column; gap: var(--s-3); }
</style>
