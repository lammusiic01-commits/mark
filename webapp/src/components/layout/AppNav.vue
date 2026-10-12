<script setup>
import { RouterLink } from 'vue-router'
import Icon from '../ui/Icon.vue'

const items = [
  { to: '/dashboard', label: 'Главная', icon: 'dashboard' },
  { to: '/campaigns', label: 'Кампании', icon: 'megaphone' },
  { to: '/hypotheses', label: 'Тесты', icon: 'flask' },
  { to: '/tools', label: 'Инструменты', icon: 'wrench' },
  { to: '/settings', label: 'Настройки', icon: 'settings' },
]
</script>

<template>
  <nav class="tabbar" aria-label="Основная навигация">
    <RouterLink v-for="item in items" :key="item.to" :to="item.to" class="tab" active-class="is-active">
      <Icon :name="item.icon" :size="20" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex;
  background: rgba(24, 24, 27, 0.92); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--card-border); padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
}
.tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  color: var(--text-3); font-size: 10px; font-weight: 600; padding: 4px 0; border-radius: var(--r-sm);
}
.tab.is-active { color: var(--accent-hover); }
</style>
