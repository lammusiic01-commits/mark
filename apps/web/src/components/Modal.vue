<script setup lang="ts">
import Icon from './Icon.vue';

defineProps<{ title: string; subtitle?: string; size?: 'sm' | 'md' }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" :class="{ sm: size === 'sm' }">
      <div class="row between" style="margin-bottom: 14px">
        <div>
          <h2>{{ title }}</h2>
          <div v-if="subtitle" class="sub muted small">{{ subtitle }}</div>
        </div>
        <button class="btn ghost sm" @click="emit('close')" aria-label="Закрыть"><Icon name="close" /></button>
      </div>
      <slot />
      <div v-if="$slots.footer" class="row" style="justify-content: flex-end; margin-top: 16px">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sub {
  margin-top: 2px;
}
</style>
