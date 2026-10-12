<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navigation } from '@/router';
import { useAppStore } from '@/stores/app';
import { connectionState } from '@/api/realtime';
import Icon from './Icon.vue';
import ToastStack from './ToastStack.vue';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

onMounted(() => {
  void store.bootstrap();
});

const title = computed(() => (route.meta.title as string | undefined) ?? 'MARK');
const agency = computed(() => store.branding?.agencyName ?? 'MARK');
const hideBrand = computed(() => store.branding?.hideMarkBranding === true);
const demoMode = computed(() => store.settings?.env.demoMode === true);
const connection = computed(() => ({ online: 'Живые данные', connecting: 'Подключение…', offline: 'Нет связи с сервером' })[connectionState.value]);
const connectionTone = computed(() => (connectionState.value === 'online' ? 'success' : connectionState.value === 'connecting' ? 'info' : 'danger'));
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="logo">
        <div class="logo-mark">{{ hideBrand ? agency.slice(0, 1).toUpperCase() : 'M' }}</div>
        <div class="logo-text">
          <strong>{{ hideBrand ? agency : 'MARK' }}</strong>
          <span>{{ hideBrand ? 'кабинет агентства' : 'SEO · GEO · BotShield' }}</span>
        </div>
      </div>

      <nav class="nav">
        <RouterLink v-for="item in navigation" :key="item.path" :to="item.path" :class="{ active: route.path === item.path }">
          <Icon :name="item.icon" />
          <span>{{ item.title }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="row small">
          <span class="pill" :class="connectionTone"><span class="dot-indicator" />{{ connection }}</span>
        </div>
        <div v-if="demoMode" class="small faint">Включён демо-режим: внешние сервисы не вызываются</div>
        <div class="small faint">Версия {{ store.meta?.version ?? '1.0.0' }}</div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <h1>{{ title }}</h1>
        <div class="spacer" />

        <select
          v-if="store.clients.length"
          :value="store.activeClientId"
          style="width: 240px"
          @change="store.setActiveClient(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Все клиенты</option>
          <option v-for="client in store.clients" :key="client.id" :value="client.id">{{ client.name }}</option>
        </select>

        <button class="btn sm" title="Обновить справочники" @click="store.bootstrap()"><Icon name="refresh" /> Обновить</button>
        <button class="btn sm" title="Быстрый запуск полного цикла" @click="router.push('/schedules')"><Icon name="bolt" /> Автопилот</button>
      </header>

      <div class="content">
        <slot />
      </div>
    </main>

    <ToastStack />
  </div>
</template>

<style scoped>
.dot-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
}
</style>
