<script setup lang="ts">
/** Светящийся орб — фирменное пятно света за ключевыми блоками. */
withDefaults(defineProps<{ size?: number; top?: string; left?: string; right?: string; opacity?: number }>(), {
  size: 220,
  top: '-60px',
  left: undefined,
  right: undefined,
  opacity: 0.5,
});
</script>

<template>
  <span
    class="orb"
    :style="{ width: `${size}px`, height: `${size}px`, top, left, right, opacity: String(opacity) }"
    aria-hidden="true"
  />
</template>
