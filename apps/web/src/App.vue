<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import { subscribeChannels } from '@/api/realtime';
import { useAppStore } from '@/stores/app';

const store = useAppStore();
const route = useRoute();

/**
 * Мини-приложение Telegram — отдельный режим: своя тёмная тема, свой таббар,
 * ни рабочего стола, ни бокового меню. Проверяем и по маршруту, и по факту
 * открытия внутри Telegram (тогда любой экран показываем в режиме приложения).
 */
const isMiniApp = computed(() => route.name === 'tg');

onMounted(() => {
  // Общий канал активности: фоновые события (правила, аудиты, BotShield) показываем тостами
  subscribeChannels(['activity'], (event) => {
    if (event.type === 'scheduler:notice') {
      const payload = event.payload as { title?: string; lines?: string[] };
      store.toast('info', payload.title ?? 'Автооптимизация', payload.lines?.join(' · '));
    }
    if (event.type?.startsWith('system')) return;
    void store.loadDashboard();
  });
});
</script>

<template>
  <RouterView v-if="isMiniApp" v-slot="{ Component }">
    <component :is="Component" />
  </RouterView>
  <AppShell v-else>
    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </AppShell>
</template>
