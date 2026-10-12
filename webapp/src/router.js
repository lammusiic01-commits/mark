import { createRouter, createWebHistory } from 'vue-router'
import { api } from './composables/useApi.js'

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/onboarding', name: 'onboarding', component: () => import('./pages/Onboarding.vue'), meta: { title: 'Старт', bare: true } },
  { path: '/dashboard', name: 'dashboard', component: () => import('./pages/Dashboard.vue'), meta: { title: 'Главная', tab: 'dashboard' } },
  { path: '/connect', name: 'connect', component: () => import('./pages/Connect.vue'), meta: { title: 'Подключения', back: '/settings' } },
  { path: '/campaigns', name: 'campaigns', component: () => import('./pages/Campaigns.vue'), meta: { title: 'Кампании', tab: 'campaigns' } },
  { path: '/campaigns/:id', name: 'campaign', component: () => import('./pages/CampaignDetail.vue'), meta: { title: 'Кампания', back: '/campaigns' } },
  { path: '/bot-shield', name: 'bot-shield', component: () => import('./pages/BotShield.vue'), meta: { title: 'Bot Shield', back: '/tools' } },
  { path: '/hypotheses', name: 'hypotheses', component: () => import('./pages/Hypotheses.vue'), meta: { title: 'A/B тесты', tab: 'hypotheses' } },
  { path: '/seo', name: 'seo', component: () => import('./pages/SeoLab.vue'), meta: { title: 'SEO-лаборатория', back: '/tools' } },
  { path: '/competitors', name: 'competitors', component: () => import('./pages/Competitors.vue'), meta: { title: 'Конкуренты', back: '/tools' } },
  { path: '/roi', name: 'roi', component: () => import('./pages/RoiCalc.vue'), meta: { title: 'ROI-калькулятор', back: '/tools' } },
  { path: '/funnel', name: 'funnel', component: () => import('./pages/Funnel.vue'), meta: { title: 'Воронка', back: '/tools' } },
  { path: '/reports', name: 'reports', component: () => import('./pages/Reports.vue'), meta: { title: 'Отчёты', back: '/tools' } },
  { path: '/balance', name: 'balance', component: () => import('./pages/Balance.vue'), meta: { title: 'Баланс', back: '/settings' } },
  { path: '/settings', name: 'settings', component: () => import('./pages/Settings.vue'), meta: { title: 'Настройки', tab: 'settings' } },
  { path: '/tools', name: 'tools', component: () => import('./pages/Tools.vue'), meta: { title: 'Инструменты', tab: 'tools' } },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

// Онбординг: новый пользователь сначала проходит короткий старт.
let onboardedCache = null
export function markOnboarded(value = true) {
  onboardedCache = value
}

router.beforeEach(async (to) => {
  if (to.name === 'onboarding') return true
  if (onboardedCache === null) {
    try {
      const s = await api.get('/settings')
      onboardedCache = !!s.onboarded
    } catch (_) {
      onboardedCache = true // сервер недоступен: показываем экран с ошибкой, а не онбординг
    }
  }
  if (!onboardedCache) return { name: 'onboarding' }
  return true
})

export default router
