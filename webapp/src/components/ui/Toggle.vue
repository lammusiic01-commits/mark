<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  hint: { type: String, default: '' },
})
defineEmits(['update:modelValue'])
</script>

<template>
  <label class="toggle-row">
    <span class="grow">
      <span class="toggle-label">{{ label }}</span>
      <span v-if="hint" class="hint toggle-hint">{{ hint }}</span>
    </span>
    <input type="checkbox" class="switch" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)" />
  </label>
</template>

<style scoped>
.toggle-row { display: flex; align-items: center; gap: var(--s-3); cursor: pointer; }
.toggle-label { font-weight: 600; }
.toggle-hint { display: block; margin-top: 2px; }
.switch {
  appearance: none; -webkit-appearance: none; width: 44px; height: 26px; border-radius: 13px; flex: 0 0 44px;
  background: var(--bg-elevated); position: relative; cursor: pointer; transition: background var(--dur) var(--ease);
}
.switch::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; transition: transform var(--dur) var(--ease);
}
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(18px); }
</style>
