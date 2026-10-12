<script setup>
defineProps({ title: { type: String, default: '' }, sub: { type: String, default: '' } })
</script>

<template>
  <div class="page">
    <header v-if="title" class="page-head">
      <h1 class="page-title">{{ title }}</h1>
      <div v-if="sub" class="page-sub">{{ sub }}</div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.page-head { margin-bottom: 4px; }
</style>
