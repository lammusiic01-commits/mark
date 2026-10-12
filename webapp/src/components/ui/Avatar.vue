<script setup>
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, default: '' },
  size: { type: Number, default: 36 },
})

const initials = computed(() => {
  const parts = props.name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('')
})
</script>

<template>
  <div class="avatar" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.36) + 'px' }">
    {{ initials }}
  </div>
</template>

<style scoped>
.avatar {
  display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
  border-radius: var(--r-md); background: var(--accent-bg); color: var(--accent-hover);
  font-weight: 600;
}
</style>
