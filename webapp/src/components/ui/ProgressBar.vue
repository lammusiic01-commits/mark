<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 },   // 0..100
  tone: { type: String, default: 'accent' }, // accent | green | amber | red
})

const width = computed(() => Math.max(0, Math.min(100, props.value)))
const color = computed(() => ({
  accent: 'var(--accent)', green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)',
}[props.tone]))
</script>

<template>
  <div class="bar" role="progressbar" :aria-valuenow="width" aria-valuemin="0" aria-valuemax="100">
    <div class="bar-fill" :style="{ width: width + '%', background: color }"></div>
  </div>
</template>

<style scoped>
.bar { height: 6px; border-radius: 3px; background: var(--bg-elevated); overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 400ms var(--ease); }
</style>
