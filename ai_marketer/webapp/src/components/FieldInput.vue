<template>
  <!-- Поле ввода: подпись, подсказка, ошибка и «глаз» для секретов -->
  <label class="field">
    <span v-if="label" class="field-label">{{ label }}</span>

    <span class="field-box" :class="{ invalid: Boolean(error), focused }">
      <input
        :type="currentType"
        :value="modelValue"
        :placeholder="placeholder"
        :inputmode="inputmode"
        :autocomplete="autocomplete"
        :spellcheck="false"
        :disabled="disabled"
        @input="onInput"
        @focus="focused = true"
        @blur="focused = false"
      />
      <button v-if="secret" class="eye" type="button" @click="toggleVisible">
        {{ visible ? 'скрыть' : 'показать' }}
      </button>
    </span>

    <span v-if="error" class="field-error">{{ error }}</span>
    <span v-else-if="hint" class="field-hint">{{ hint }}</span>
  </label>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useHaptics } from '../composables/useHaptics'

const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
  secret: { type: Boolean, default: false },
  inputmode: { type: String, default: 'text' },
  autocomplete: { type: String, default: 'off' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'enter'])
const haptics = useHaptics()
const visible = ref(false)
const focused = ref(false)

const currentType = computed(() => (props.secret && !visible.value ? 'password' : props.inputmode === 'numeric' ? 'tel' : 'text'))

function onInput(event) {
  emit('update:modelValue', event.target.value)
}

function toggleVisible() {
  haptics.select()
  visible.value = !visible.value
}
</script>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.field-label {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.field-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  min-height: 50px;
  border-radius: var(--radius-md);
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  transition: border-color var(--duration-fast) var(--ease-ios), background var(--duration-fast) var(--ease-ios);
}

.field-box.focused {
  border-color: rgba(10, 132, 255, 0.55);
  background: rgba(10, 132, 255, 0.08);
}

.field-box.invalid {
  border-color: rgba(255, 69, 58, 0.6);
}

.field-box input {
  flex: 1;
  min-width: 0;
  padding: 14px 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: var(--font-text);
  font-size: var(--fs-body);
}

.field-box input::placeholder {
  color: var(--text-tertiary);
}

.eye {
  flex: none;
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
  text-transform: lowercase;
}

.field-hint {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  line-height: 1.4;
}

.field-error {
  font-size: var(--fs-caption);
  color: var(--accent-red);
  line-height: 1.4;
}
</style>
