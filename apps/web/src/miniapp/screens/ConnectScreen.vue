<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import ServiceSheet from '../components/ServiceSheet.vue';
import { tgApi, type MiniService } from '../api';
import { statusLabel, statusVariant, timeAgo } from '../format';
import { select } from '../telegram';
import { toastErr } from '../useToasts';

/**
 * Подключения: все сервисы агентства в одном экране.
 *
 * Показываем три состояния: подключено, не подключено, ошибка. Первыми идут
 * те сервисы, без которых продукт не работает (Директ, Метрика, хостинг),
 * дальше — остальные. У каждого открывается шторка с инструкцией «где взять
 * ключ» и живой проверкой токена.
 */

const services = ref<MiniService[]>([]);
const loading = ref(true);
const activeId = ref<string | null>(null);
const filter = ref<'all' | 'connected' | 'available'>('all');
const search = ref('');

const PRIORITY = ['yandex-direct', 'yandex-metrika', 'tilda', 'wordpress', 'vercel', 'netlify', 'github', 'ftp-hosting', 'telegram', 'openai'];

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await tgApi.get<{ items: MiniService[] }>('/services');
    services.value = response.items;
  } catch (error) {
    toastErr('Не удалось загрузить каталог', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

const grouped = computed(() => {
  const query = search.value.trim().toLowerCase();
  const list = services.value
    .filter((service) => {
      if (filter.value === 'connected' && !service.account) return false;
      if (filter.value === 'available' && service.account) return false;
      if (query && !`${service.name} ${service.vendor} ${service.category}`.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => {
      const priorityA = PRIORITY.indexOf(a.id);
      const priorityB = PRIORITY.indexOf(b.id);
      if (priorityA !== -1 || priorityB !== -1) {
        if (priorityA === -1) return 1;
        if (priorityB === -1) return -1;
        return priorityA - priorityB;
      }
      return a.name.localeCompare(b.name);
    });

  const order: string[] = [];
  const groups = new Map<string, MiniService[]>();
  for (const service of list) {
    const title = service.category;
    if (!groups.has(title)) {
      groups.set(title, []);
      order.push(title);
    }
    groups.get(title)!.push(service);
  }
  return order.map((title) => ({ title, items: groups.get(title)! }));
});

const connectedCount = computed(() => services.value.filter((service) => service.account).length);
const active = computed(() => services.value.find((service) => service.id === activeId.value) ?? null);

function open(service: MiniService): void {
  select();
  activeId.value = service.id;
}
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Ключи и доступы</div>
        <h1 class="mini-title">Подключения</h1>
      </div>
      <span class="badge badge-accent">{{ connectedCount }} из {{ services.length }}</span>
    </header>

    <input v-model="search" class="input" placeholder="Поиск сервиса" style="margin-bottom: 12px" />

    <div class="tabs" style="margin-bottom: 16px">
      <button :class="{ active: filter === 'all' }" @click="filter = 'all'">Все</button>
      <button :class="{ active: filter === 'connected' }" @click="filter = 'connected'">Подключены</button>
      <button :class="{ active: filter === 'available' }" @click="filter = 'available'">Доступны</button>
    </div>

    <LoaderBlock v-if="loading" :rows="4" label="Загружаем каталог сервисов" />

    <template v-else>
      <div v-for="group in grouped" :key="group.title">
        <div class="mini-section-title">{{ group.title }}</div>
        <GlassCard v-for="service in group.items" :key="service.id" tight style="margin-bottom: 8px">
          <button style="all: unset; display: block; width: 100%; cursor: pointer" @click="open(service)">
            <div class="mini-row">
              <div class="list-icon" :style="service.color ? { background: `${service.color}22`, color: service.color } : {}">
                {{ service.account ? '✅' : '🔌' }}
              </div>
              <div style="flex: 1; min-width: 0">
                <div class="list-item-title" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ service.name }}</div>
                <div class="mini-hint">
                  {{ service.account ? `${service.account.label} · ${timeAgo(service.account.lastCheckedAt)}` : service.vendor }}
                </div>
              </div>
              <span class="badge" :class="statusVariant(service.status)">{{ statusLabel(service.status) }}</span>
            </div>
          </button>
        </GlassCard>
      </div>

      <GlassCard style="margin-top: 16px">
        <div style="font-weight: 600; margin-bottom: 6px">Окно входа в сервис</div>
        <div class="mini-hint" style="line-height: 1.6">
          Для сервисов без API (Яндекс Бизнес, Google Business, некоторые CMS) используйте вход в окне приложения: логин и пароль вводятся только на
          странице сервиса, MARK получает доступ к разделам и дальше работает с ними сам.
        </div>
        <GlassButton size="sm" block style="margin-top: 10px" @click="open(services.find((item) => item.authModes.some((mode) => mode.needsInAppLogin)) ?? services[0]!)">
          Показать пример
        </GlassButton>
      </GlassCard>
    </template>
  </div>

  <ServiceSheet :open="Boolean(active)" :service="active" @close="activeId = null" @connected="load" />
</template>
