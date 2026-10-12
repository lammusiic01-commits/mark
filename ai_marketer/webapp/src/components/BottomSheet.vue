<template>
  <!-- Нижняя панель: выезжает снизу, как в iOS; закрывается по фону и свайпу вниз -->
  <Teleport to="body">
    <transition name="sheet">
      <div v-if="modelValue" class="sheet-overlay" @click.self="close">
        <section class="sheet safe-bottom" :style="{ maxHeight: `${maxHeight}vh` }">
          <header class="sheet-head" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
            <span class="handle" />
            <div class="sheet-titles">
              <h2 class="sheet-title">{{ title }}</h2>
              <p v-if="subtitle" class="sheet-subtitle">{{ subtitle }}</p>
            </div>
            <button class="close-btn" type="button" aria-label="Закрыть" @click="close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>

          <div class="sheet-body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="sheet-footer">
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue'
import { useHaptics } from '../composables/useHaptics'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  maxHeight: { type: Number, default: 88 },
})

const emit = defineEmits(['update:modelValue', 'close'])
const haptics = useHaptics()

function close() {
  haptics.light()
  emit('update:modelValue', false)
  emit('close')
}

/* Свайп вниз по «ручке» закрывает панель — привычный жест в мессенджере */
let startY = ref(0)

function onTouchStart(event) {
  startY.value = event.changedTouches?.[0]?.clientY || 0
}

function onTouchEnd(event) {
  const endY = event.changedTouches?.[0]?.clientY || 0
  if (endY - startY.value > 70) close()
}
</script>

<style scoped>
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.sheet {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  background: var(--surface-glass-strong);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid var(--border-subtle);
  border-bottom: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.sheet-head {
  position: relative;
  flex: none;
  padding: var(--space-5) var(--space-5) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
  touch-action: pan-y;
}

.handle {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  width: 38px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
}

.sheet-titles {
  padding-right: 40px;
}

.sheet-title {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.02em;
}

.sheet-subtitle {
  margin-top: 3px;
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.35;
}

.close-btn {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  width: 32px;
  height: 32px;
  padding: 7px;
  border-radius: 50%;
  background: var(--surface-overlay);
  color: var(--text-secondary);
}

.close-btn svg {
  width: 100%;
  height: 100%;
  display: block;
}

.sheet-body {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-4) var(--space-5) var(--space-5);
}

.sheet-footer {
  flex: none;
  padding: var(--space-3) var(--space-5) var(--space-5);
  border-top: 1px solid var(--border-subtle);
  background: rgba(10, 10, 10, 0.5);
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--duration-normal) var(--ease-ios);
}

.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform var(--duration-normal) var(--ease-ios);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(100%);
}
</style>
