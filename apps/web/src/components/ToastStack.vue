<script setup lang="ts">
import { useAppStore } from '@/stores/app';
import Icon from './Icon.vue';

const store = useAppStore();
</script>

<template>
  <div class="toasts">
    <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="toast.variant">
      <div class="row between">
        <strong>{{ toast.title }}</strong>
        <button class="btn ghost sm" @click="store.dismiss(toast.id)" aria-label="Скрыть"><Icon name="close" :size="14" /></button>
      </div>
      <div v-if="toast.message" class="small">{{ toast.message }}</div>
    </div>
  </div>
</template>
