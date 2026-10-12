<template>
  <!-- Нижняя навигация: 5 главных разделов, как в нативном приложении -->
  <nav class="bottom-nav safe-bottom">
    <button
      v-for="item in items"
      :key="item.path"
      class="nav-item"
      :class="{ active: isActive(item) }"
      type="button"
      @click="go(item)"
    >
      <span class="nav-icon" v-html="item.icon" />
      <span class="nav-label">{{ item.label }}</span>
      <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
    </button>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../store'
import { useHaptics } from '../composables/useHaptics'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const haptics = useHaptics()

/* Иконки — простые контуры: одинаковый вес линий выглядит аккуратно */
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M9.6 21v-6h4.8v6"/></svg>',
  campaigns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="12" width="3" height="5" rx="1"/><rect x="12" y="8" width="3" height="9" rx="1"/><rect x="17" y="5" width="3" height="12" rx="1"/></svg>',
  hypotheses: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.2 1 2h5.2c.1-.8.4-1.5 1-2A6 6 0 0 0 12 3Z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
}

const items = computed(() => [
  { label: 'Главная', path: '/', icon: ICONS.home },
  { label: 'Кампании', path: '/campaigns', icon: ICONS.campaigns },
  { label: 'Гипотезы', path: '/hypotheses', icon: ICONS.hypotheses, badge: store.pendingHypotheses || 0 },
  { label: 'Баланс', path: '/balance', icon: ICONS.wallet },
  { label: 'Отчёты', path: '/reports', icon: ICONS.more },
])

function isActive(item) {
  if (item.path === '/') return route.path === '/'
  return route.path.startsWith(item.path)
}

function go(item) {
  if (isActive(item)) return
  haptics.light()
  router.push(item.path)
}
</script>

<style scoped>
.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
  padding: 8px 6px calc(8px + env(safe-area-inset-bottom));
  background: rgba(10, 10, 10, 0.86);
  -webkit-backdrop-filter:
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border-top: 1px solid var(--border-subtle);
}

.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 2px;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  transition: color var(--duration-fast) var(--ease-ios), transform var(--duration-fast) var(--ease-ios);
}

.nav-item:active {
  transform: scale(0.94);
}

.nav-item.active {
  color: var(--text-primary);
}

.nav-icon {
  width: 24px;
  height: 24px;
  display: block;
}

.nav-icon :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

.nav-label {
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
  letter-spacing: -0.01em;
}

.nav-badge {
  position: absolute;
  top: 2px;
  right: 50%;
  transform: translateX(14px);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--accent-orange);
  color: #000;
  font-size: 10px;
  font-weight: var(--fw-bold);
  line-height: 16px;
  text-align: center;
}

.nav-item.active .nav-icon {
  color: var(--accent-blue);
}
</style>
