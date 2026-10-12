<script setup>
defineProps({ height: { type: Number, default: 64 }, lines: { type: Number, default: 1 } })
</script>

<template>
  <div class="stack">
    <div v-for="n in lines" :key="n" class="skeleton" :style="{ height: height + 'px' }"></div>
  </div>
</template>
