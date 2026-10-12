<script setup>
import Icon from './Icon.vue'
defineProps({
  icon: { type: String, default: 'info' },
  title: { type: String, required: true },
  text: { type: String, default: '' },
})
</script>

<template>
  <div class="empty">
    <div class="icon-tile accent"><Icon :name="icon" :size="18" /></div>
    <div class="empty-title">{{ title }}</div>
    <div v-if="text" class="hint">{{ text }}</div>
    <div v-if="$slots.default" class="empty-action"><slot /></div>
  </div>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: var(--s-6) var(--s-2); }
.empty-title { font-weight: 600; }
.empty-action { margin-top: 6px; }
</style>
