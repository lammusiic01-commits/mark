<template>
  <!-- Пустое состояние: объясняем, почему пока пусто, и что сделать -->
  <div class="empty">
    <div class="empty-icon">{{ icon }}</div>
    <h3 class="empty-title">{{ title }}</h3>
    <p v-if="text" class="empty-text">{{ text }}</p>
    <GlassButton v-if="action" variant="secondary" size="md" :loading="loading" @click="$emit('action')">
      {{ action }}
    </GlassButton>
    <slot />
  </div>
</template>

<script setup>
import GlassButton from './GlassButton.vue'

defineProps({
  icon: { type: String, default: '📊' },
  title: { type: String, required: true },
  text: { type: String, default: '' },
  action: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})

defineEmits(['action'])
</script>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-5);
}

.empty-icon {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
}

.empty-title {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
}

.empty-text {
  max-width: 300px;
  font-size: var(--fs-footnote);
  line-height: 1.45;
  color: var(--text-secondary);
}
</style>
