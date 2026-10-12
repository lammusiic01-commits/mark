/*
  Маршруты приложения.
  Правило входа: пока пользователь не прошёл онбординг, любой экран ведёт на
  знакомство — человек сначала подключает Директ и Метрику, а потом уже видит
  цифры. Исключения: сами шаги онбординга и экран подключений.
*/
import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', name: 'dashboard', component: () => import('./pages/Dashboard.vue') },
  { path: '/onboarding', name: 'onboarding', component: () => import('./pages/Onboarding.vue'), meta: { public: true } },
  { path: '/connect', name: 'connect', component: () => import('./pages/Connect.vue'), meta: { public: true } },
  { path: '/campaigns', name: 'campaigns', component: () => import('./pages/Campaigns.vue') },
  { path: '/bot-shield', name: 'bot-shield', component: () => import('./pages/BotShield.vue') },
  { path: '/hypotheses', name: 'hypotheses', component: () => import('./pages/Hypotheses.vue') },
  { path: '/balance', name: 'balance', component: () => import('./pages/Balance.vue') },
  { path: '/reports', name: 'reports', component: () => import('./pages/Reports.vue') },
  { path: '/settings', name: 'settings', component: () => import('./pages/Settings.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true

  // Состояние берём из общего хранилища: один запрос на приложение, не на переход
  const { useAppStore } = await import('./store')
  const store = useAppStore()

  // Не мешаем, пока идёт первая загрузка: App.vue сам решит, что показать
  if (!store.ready || store.offline) return true

  const completed = store.user?.onboarding_completed ?? store.dashboard?.user?.onboarding_completed
  if (completed === false) {
    return { path: '/onboarding', replace: true }
  }
  return true
})

export default router
