<script setup lang="ts">
import { toasts, dismiss } from '../useToasts';
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.variant" @click="dismiss(toast.id)">
          <span>{{ toast.variant === 'success' ? '✅' : toast.variant === 'error' ? '⚠️' : 'ℹ️' }}</span>
          <div>
            <div style="font-weight: 600">{{ toast.title }}</div>
            <div v-if="toast.message" class="mini-hint">{{ toast.message }}</div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 220ms cubic-bezier(0.32, 0.72, 0, 1), transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
