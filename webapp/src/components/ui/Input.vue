<script setup>
defineProps({
  modelValue: { type: [String, Number], default: '' },
  label: { type: String, default: '' },
  type: { type: String, default: 'text' },
  placeholder: { type: String, default: '' },
  inputmode: { type: String, default: undefined },
  hint: { type: String, default: '' },
  autocomplete: { type: String, default: 'off' },
})
defineEmits(['update:modelValue'])
</script>

<template>
  <label class="field">
    <span v-if="label" class="field-label">{{ label }}</span>
    <input
      class="input"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :inputmode="inputmode"
      :autocomplete="autocomplete"
      autocapitalize="off"
      spellcheck="false"
      @input="$emit('update:modelValue', type === 'number' ? $event.target.valueAsNumber || 0 : $event.target.value)"
    />
    <span v-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>
