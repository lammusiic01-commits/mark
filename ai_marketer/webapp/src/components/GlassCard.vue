<template>
  <div class="glass-card" :class="{ interactive }">
    <slot />
  </div>
</template>

<script setup>
defineProps({ interactive: Boolean })
</script>

<style scoped>
.glass-card {
  background: var(--surface-glass);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  position: relative;
  transition: all var(--duration-normal) var(--ease-ios);
}

.glass-card.interactive {
  cursor: pointer;
}
.glass-card.interactive:active {
  transform: scale(0.98);
  background: var(--surface-glass-strong);
}
</style>
