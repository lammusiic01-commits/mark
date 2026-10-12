<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
  icon?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}>();
</script>

<template>
  <div class="card tight">
    <div class="row between">
      <span class="stat">
        <span class="label">{{ label }}</span>
        <span class="value" :class="tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : ''">{{ value }}</span>
      </span>
      <Icon v-if="icon" :name="icon" :size="20" class="muted" />
    </div>
    <div class="row small muted" v-if="hint || delta !== undefined && delta !== null">
      <span v-if="delta !== undefined && delta !== null" :class="delta >= 0 ? 'text-success' : 'text-danger'">{{ delta >= 0 ? '+' : '' }}{{ delta }}%</span>
      <span v-if="hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped>
.text-success {
  color: #86efac;
}

.text-danger {
  color: #fca5a5;
}

.text-warning {
  color: #fcd34d;
}
</style>
