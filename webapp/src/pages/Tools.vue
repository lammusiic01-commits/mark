<script setup>
import { RouterLink } from 'vue-router'
import Icon from '../components/ui/Icon.vue'

const tools = [
  { to: '/bot-shield', icon: 'shield', title: 'Bot Shield', text: 'Накрутка и боты' },
  { to: '/seo', icon: 'search', title: 'SEO-лаборатория', text: 'Аудит страниц' },
  { to: '/competitors', icon: 'globe', title: 'Конкуренты', text: 'Мониторинг страниц' },
  { to: '/roi', icon: 'calculator', title: 'ROI-калькулятор', text: 'Прогноз окупаемости' },
  { to: '/funnel', icon: 'filter', title: 'Воронка', text: 'Где теряются люди' },
  { to: '/reports', icon: 'file', title: 'Отчёты', text: 'Сводки за период' },
  { to: '/hypotheses', icon: 'flask', title: 'A/B тесты', text: 'Статистическая значимость' },
  { to: '/balance', icon: 'wallet', title: 'Баланс', text: 'Пополнение и история' },
]
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">Инструменты</div>
      <div class="page-sub">Всё, что помогает принимать решения</div>
    </div>
    <div class="tools">
      <RouterLink v-for="t in tools" :key="t.to" :to="t.to" class="card tool">
        <div class="icon-tile accent"><Icon :name="t.icon" :size="18" /></div>
        <div class="tool-title">{{ t.title }}</div>
        <div class="xs muted">{{ t.text }}</div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.tools { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); }
.tool { display: flex; flex-direction: column; gap: 6px; color: var(--text-1); }
.tool:active { background: var(--card-bg-hover); }
.tool-title { font-weight: 600; margin-top: 4px; }
</style>
