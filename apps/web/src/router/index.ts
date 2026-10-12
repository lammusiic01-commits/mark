import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

/**
 * Hash-история выбрана осознанно: приложение одинаково работает и в браузере,
 * и внутри Electron, и на статике без настройки fallback на сервере.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { title: 'Дашборд', icon: 'grid' } },
  { path: '/connect', name: 'connect', component: () => import('@/views/ConnectView.vue'), meta: { title: 'Подключения', icon: 'plug' } },
  { path: '/sites', name: 'sites', component: () => import('@/views/SitesView.vue'), meta: { title: 'Сайты и SEO', icon: 'globe' } },
  { path: '/bots', name: 'bots', component: () => import('@/views/BotShieldView.vue'), meta: { title: 'BotShield', icon: 'shield' } },
  { path: '/geo', name: 'geo', component: () => import('@/views/GeoView.vue'), meta: { title: 'GEO-анализ', icon: 'map' } },
  { path: '/market', name: 'market', component: () => import('@/views/MarketView.vue'), meta: { title: 'Market Analyzer', icon: 'chart' } },
  { path: '/hypotheses', name: 'hypotheses', component: () => import('@/views/HypothesesView.vue'), meta: { title: 'Гипотезы', icon: 'flask' } },
  { path: '/campaigns', name: 'campaigns', component: () => import('@/views/CampaignsView.vue'), meta: { title: 'Кампании', icon: 'target' } },
  { path: '/schedules', name: 'schedules', component: () => import('@/views/SchedulesView.vue'), meta: { title: 'Автооптимизация', icon: 'clock' } },
  { path: '/reports', name: 'reports', component: () => import('@/views/ReportsView.vue'), meta: { title: 'Отчёты', icon: 'file' } },
  { path: '/branding', name: 'branding', component: () => import('@/views/BrandingView.vue'), meta: { title: 'Белая метка', icon: 'sparkles' } },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'Настройки', icon: 'settings' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((to) => {
  const title = (to.meta.title as string | undefined) ?? 'MARK';
  document.title = `${title} · MARK`;
});

export const navigation = routes
  .filter((route) => route.meta && route.meta.title)
  .map((route) => ({ path: route.path, title: route.meta!.title as string, icon: route.meta!.icon as string }));
