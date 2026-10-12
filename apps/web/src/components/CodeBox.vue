<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ code: string; label?: string; maxHeight?: number }>(), { maxHeight: 260 });
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1800);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div>
    <div class="row between small" style="margin-bottom: 6px">
      <span class="muted">{{ label ?? 'Готовый артефакт' }}</span>
      <button class="btn ghost sm" @click="copy"><Icon :name="copied ? 'check' : 'copy'" /> {{ copied ? 'Скопировано' : 'Копировать' }}</button>
    </div>
    <pre class="log" :style="{ maxHeight: `${maxHeight}px` }">{{ code }}</pre>
  </div>
</template>
