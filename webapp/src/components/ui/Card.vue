<script setup>
defineProps({ title: { type: String, default: '' }, clickable: { type: Boolean, default: false } })
defineEmits(['click'])
</script>

<template>
  <section class="card" :class="{ clickable }" @click="clickable && $emit('click')">
    <div v-if="title" class="card-title">{{ title }}</div>
    <slot />
  </section>
</template>
