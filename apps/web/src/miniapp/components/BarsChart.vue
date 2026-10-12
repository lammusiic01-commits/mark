<script setup lang="ts">
import { computed } from 'vue';

/** Столбики: показывают распределение (регионы, часы, дни). */
const props = defineProps<{ values: number[]; labels?: string[]; max?: number }>();

const peak = computed(() => props.max ?? Math.max(1, ...props.values));
const heightFor = (value: number): string => `${Math.max(4, Math.round((value / peak.value) * 100))}%`;
</script>

<template>
  <div>
    <div class="bars">
      <span v-for="(value, index) in values" :key="index" :style="{ height: heightFor(value) }" :title="String(value)" />
    </div>
    <div v-if="labels?.length" class="mini-row-between mini-hint" style="margin-top: 6px">
      <span>{{ labels[0] }}</span>
      <span>{{ labels[labels.length - 1] }}</span>
    </div>
  </div>
</template>
