<script setup>
defineProps({
  modelValue: { type: [String, Number], required: true },
  items: { type: Array, required: true }, // [{ value, label }]
})
defineEmits(['update:modelValue'])
</script>

<template>
  <div class="segmented" role="tablist">
    <button
      v-for="item in items"
      :key="item.value"
      role="tab"
      :aria-selected="item.value === modelValue"
      :class="{ active: item.value === modelValue }"
      @click="$emit('update:modelValue', item.value)"
    >{{ item.label }}</button>
  </div>
</template>
