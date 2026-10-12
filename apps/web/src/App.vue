<script setup lang="ts">
import { onMounted } from 'vue';
import AppShell from './components/AppShell.vue';
import { subscribeChannels } from '@/api/realtime';
import { useAppStore } from '@/stores/app';

const store = useAppStore();

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
  <AppShell>
    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </AppShell>
</template>
