<script setup>
import Icon from '../ui/Icon.vue'
defineProps({ title: { type: String, default: '' }, canBack: { type: Boolean, default: false } })
defineEmits(['back'])
</script>

<template>
  <header class="app-header">
    <button v-if="canBack" class="btn btn-ghost btn-icon" aria-label="Назад" @click="$emit('back')">
      <Icon name="back" :size="18" />
    </button>
    <div class="app-title ellipsis">{{ title }}</div>
  </header>
</template>

<style scoped>
.app-header {
  position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: var(--s-2);
  height: 52px; padding: 0 var(--s-4); background: rgba(9, 9, 11, 0.85);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--card-border);
  padding-top: env(safe-area-inset-top);
}
.app-title { font-weight: 600; font-size: var(--text-lg); }
</style>
