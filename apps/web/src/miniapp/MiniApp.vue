<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import GlassButton from './components/GlassButton.vue';
import LoaderBlock from './components/LoaderBlock.vue';
import ToastLayer from './components/ToastLayer.vue';
import BalanceScreen from './screens/BalanceScreen.vue';
import BotsScreen from './screens/BotsScreen.vue';
import CampaignsScreen from './screens/CampaignsScreen.vue';
import ConnectScreen from './screens/ConnectScreen.vue';
import DashboardScreen from './screens/DashboardScreen.vue';
import GrowthScreen from './screens/GrowthScreen.vue';
import HypothesesScreen from './screens/HypothesesScreen.vue';
import MoreScreen from './screens/MoreScreen.vue';
import OnboardingScreen from './screens/OnboardingScreen.vue';
import ReportsScreen from './screens/ReportsScreen.vue';
import SettingsScreen from './screens/SettingsScreen.vue';
import { initTelegramShell, setBackButton } from './telegram';
import { back, bootError, currentScreen, go, loadSession, loadingSession, previousScreen } from './useMiniapp';
import './styles.css';

/**
 * Оболочка мини-приложения.
 *
 * Отвечает за: запуск (проверка подписи Telegram, загрузка агентства), нижний
 * таббар, переходы между экранами и системную кнопку «назад» внутри Telegram.
 * Экраны второго уровня (например, «Кампании») открываются поверх таббара,
 * как в системных приложениях.
 */

const TABS: { id: 'dashboard' | 'growth' | 'bots' | 'balance' | 'more'; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '◎', label: 'Сводка' },
  { id: 'growth', icon: '↗', label: 'Рост' },
  { id: 'bots', icon: '🛡', label: 'Боты' },
  { id: 'balance', icon: '₽', label: 'Баланс' },
  { id: 'more', icon: '⋯', label: 'Ещё' },
];

const SUBSCREENS = new Set(['campaigns', 'hypotheses', 'connect', 'reports', 'settings', 'onboarding']);

const activeTab = computed(() => {
  if (currentScreen.value === 'dashboard') return 'dashboard';
  if (currentScreen.value === 'growth') return 'growth';
  if (currentScreen.value === 'bots') return 'bots';
  if (currentScreen.value === 'balance') return 'balance';
  return 'more';
});

const showTabbar = computed(() => currentScreen.value !== 'onboarding');

onMounted(async () => {
  initTelegramShell();
  await loadSession();
  // Системная кнопка «назад» появляется на экранах второго уровня
  syncBackButton();
});

/** Кнопка «назад» нужна только там, где есть куда возвращаться. */
function syncBackButton(): void {
  const screen = currentScreen.value;
  setBackButton(SUBSCREENS.has(screen) && screen !== 'onboarding' && Boolean(previousScreen.value) ? back : null);
}

watch([currentScreen, previousScreen], () => syncBackButton());

onUnmounted(() => setBackButton(null));

function switchTab(id: 'dashboard' | 'growth' | 'bots' | 'balance' | 'more'): void {
  go(id);
}
</script>

<template>
  <div class="mini">
    <template v-if="loadingSession">
      <div class="mini-screen">
        <LoaderBlock :rows="4" label="Открываем приложение" />
      </div>
    </template>

    <template v-else-if="bootError">
      <div class="mini-screen">
        <div class="glass glass-pad" style="margin-top: 40px">
          <div class="empty">
            <div class="empty-icon">⚠️</div>
            <div style="font-weight: 600">Сервер не отвечает</div>
            <div class="mini-hint">{{ bootError }}</div>
            <div class="mini-hint">Проверьте, что сервер MARK запущен, и откройте приложение заново.</div>
            <GlassButton variant="primary" size="sm" @click="loadSession(true)">Повторить</GlassButton>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <OnboardingScreen v-if="currentScreen === 'onboarding'" />
      <DashboardScreen v-else-if="currentScreen === 'dashboard'" />
      <GrowthScreen v-else-if="currentScreen === 'growth'" />
      <BotsScreen v-else-if="currentScreen === 'bots'" />
      <BalanceScreen v-else-if="currentScreen === 'balance'" />
      <MoreScreen v-else-if="currentScreen === 'more'" />
      <CampaignsScreen v-else-if="currentScreen === 'campaigns'" />
      <HypothesesScreen v-else-if="currentScreen === 'hypotheses'" />
      <ConnectScreen v-else-if="currentScreen === 'connect'" />
      <ReportsScreen v-else-if="currentScreen === 'reports'" />
      <SettingsScreen v-else-if="currentScreen === 'settings'" />

      <nav v-if="showTabbar" class="tabbar">
        <button v-for="tab in TABS" :key="tab.id" class="tab" :class="{ active: activeTab === tab.id }" @click="switchTab(tab.id)">
          <span class="tab-icon">{{ tab.icon }}</span>
          <span>{{ tab.label }}</span>
        </button>
      </nav>
    </template>

    <ToastLayer />
  </div>
</template>
