<template>
  <div class="orb-wrap" :style="{ width: `${size}px`, height: `${size}px` }">
    <div class="orb" />
    <div class="orb-glow" />
  </div>
</template>

<script setup>
defineProps({ size: { type: Number, default: 180 } })
</script>

<style scoped>
.orb-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.orb {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--gradient-orb);
  animation: orb-breathe 4s ease-in-out infinite;
  filter: blur(0.5px);
}

.orb-glow {
  position: absolute;
  inset: -20%;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(174, 197, 255, 0.3), transparent 60%);
  animation: orb-glow 4s ease-in-out infinite;
  z-index: -1;
}
</style>
