<script setup lang="ts">
/** Скелетон загрузки: строки-шиммеры вместо пустого экрана. */
withDefaults(defineProps<{ rows?: number; label?: string }>(), { rows: 3, label: '' });
</script>

<template>
  <div class="mini-stack">
    <div v-if="label" class="mini-row mini-muted"><span class="spinner" /> {{ label }}</div>
    <div v-for="row in rows" :key="row" class="shimmer" :style="{ height: row === 1 ? '64px' : '46px' }" />
  </div>
</template>
