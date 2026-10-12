<script setup>
defineProps({ tone: { type: String, default: 'neutral' } }) // neutral | accent | green | red | amber
</script>

<template>
  <span
    class="badge"
    :class="{
      'badge-accent': tone === 'accent',
      'badge-green': tone === 'green',
      'badge-red': tone === 'red',
      'badge-amber': tone === 'amber',
    }"
  ><slot /></span>
</template>
