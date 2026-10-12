<script setup>
import { computed } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] }, // [{ label, value, display? }]
  height: { type: Number, default: 160 },
})

const max = computed(() => Math.max(...props.items.map((i) => Number(i.value) || 0), 1))
</script>

<template>
  <div class="bars" :style="{ height: height + 'px' }">
    <div v-for="(item, idx) in items" :key="idx" class="bar-col">
      <div class="bar-value xs num">{{ item.display ?? item.value }}</div>
      <div class="bar-track">
        <div class="bar-fill" :style="{ height: Math.max(3, ((Number(item.value) || 0) / max) * 100) + '%' }"></div>
      </div>
      <div class="bar-label xs muted ellipsis">{{ item.label }}</div>
    </div>
  </div>
</template>

<style scoped>
.bars { display: flex; align-items: stretch; gap: var(--s-2); }
.bar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.bar-value { color: var(--text-2); }
.bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.bar-fill { width: 100%; background: var(--accent); border-radius: 6px 6px 2px 2px; opacity: 0.85; transition: height 400ms var(--ease); }
.bar-label { max-width: 100%; }
</style>
