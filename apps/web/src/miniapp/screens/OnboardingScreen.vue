<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import GradientOrb from '../components/GradientOrb.vue';
import ServiceSheet from '../components/ServiceSheet.vue';
import { tgApi, type MiniService } from '../api';
import { openExternal, press, haptic } from '../telegram';
import { toastErr, toastOk } from '../useToasts';
import { INSTRUCTIONS } from '../instructions';
import { agencyName, completeOnboarding, go, userName } from '../useMiniapp';

/**
 * Онбординг «с нуля до работающего маркетинга».
 *
 * Пять шагов: знакомство → Директ → Метрика → сайт → запуск. Каждый шаг можно
 * пропустить, но приложение объясняет, что он даёт и где взять ключ, — по
 * промту это главный барьер для новых пользователей.
 */

const step = ref(0);
const services = ref<Record<string, MiniService>>({});
const activeServiceId = ref<string | null>(null);
const sheetOpen = ref(false);
const started = ref(false);

const siteUrl = ref('');
const siteName = ref('');
const siteBusy = ref(false);
const siteCreated = ref<string | null>(null);
const detection = ref<{ platformName?: string; confidence?: number } | null>(null);

const STEPS = ['Знакомство', 'Яндекс Директ', 'Метрика', 'Сайт', 'Запуск'];

onMounted(async () => {
  try {
    const response = await tgApi.get<{ items: MiniService[] }>('/services');
    services.value = Object.fromEntries(response.items.map((item) => [item.id, item]));
  } catch {
    /* каталог подтянется позже — шаги всё равно работают */
  }
});

const connected = (serviceId: string): boolean => Boolean(services.value[serviceId]?.account);

const directReady = computed(() => connected('yandex-direct'));
const metrikaReady = computed(() => connected('yandex-metrika'));

function openService(serviceId: string): void {
  press();
  activeServiceId.value = serviceId;
  sheetOpen.value = true;
}

async function refreshServices(): Promise<void> {
  try {
    const response = await tgApi.get<{ items: MiniService[] }>('/services');
    services.value = Object.fromEntries(response.items.map((item) => [item.id, item]));
  } catch {
    /* игнорируем: данные обновятся при следующем действии */
  }
}

async function createSite(): Promise<void> {
  const url = siteUrl.value.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    toastErr('Проверьте адрес', 'Нужен полный адрес, например https://site.ru');
    return;
  }
  siteBusy.value = true;
  try {
    const response = await tgApi.post<{ site: { id: string }; detection: { platformName?: string; confidence?: number } | null }>('/sites', {
      name: siteName.value.trim() || new URL(url).hostname,
      url,
      regions: [213],
      keywords: [],
    });
    siteCreated.value = response.site.id;
    detection.value = response.detection;
    haptic('success');
    toastOk('Сайт добавлен', response.detection?.platformName ? `Определили платформу: ${response.detection.platformName}` : 'Платформа определится при аудите');
    step.value = 4;
  } catch (error) {
    toastErr('Не удалось добавить сайт', error instanceof Error ? error.message : String(error));
  } finally {
    siteBusy.value = false;
  }
}

async function finish(): Promise<void> {
  await completeOnboarding();
  go('growth');
}

function next(): void {
  press();
  if (step.value < 4) step.value += 1;
}

function skipAll(): void {
  press();
  void completeOnboarding();
  go('dashboard');
}

/** Демонстрация возможностей на первом экране — «что я получу». */
const PROMISES = [
  { icon: '🔍', title: 'Аудит и автоисправления', text: 'Находим проблемы сайта и правим их сами: мета-теги, robots, sitemap, скорость, разметка.' },
  { icon: '🛡', title: 'Защита от ботов', text: 'Считаем фальшивый трафик по логам и говорим, сколько денег он съедает. Отключаем источники.' },
  { icon: '📍', title: 'GEO по регионам', text: 'Показываем спрос по городам и собираем страницы под каждый регион.' },
  { icon: '📈', title: 'Автооптимизация ставок', text: 'Правила работают по расписанию: поднимаем эффективные фразы, режем дорогие.' },
];
</script>

<template>
  <div class="mini-screen">
    <div class="steps">
      <span v-for="(title, index) in STEPS" :key="title" :class="{ active: index === step, done: index < step }" />
    </div>

    <!-- Шаг 0: знакомство -->
    <template v-if="step === 0">
      <div class="orb-wrap" style="position: relative; margin-bottom: 8px">
        <GradientOrb :size="260" top="-80px" right="-60px" :opacity="0.55" />
        <div class="mini-greeting" style="margin-top: 8px">{{ agencyName }}</div>
        <h1 class="mini-title" style="font-size: 30px">Маркетинг, который работает сам</h1>
        <p class="mini-muted" style="margin-top: 8px">
          {{ userName }}, добро пожаловать. Настроим за 4 минуты: подключим Директ, Метрику и сайт — дальше MARK работает по расписанию.
        </p>
      </div>

      <div class="mini-stack" style="margin-top: 18px">
        <GlassCard v-for="item in PROMISES" :key="item.title" tight>
          <div class="mini-row" style="align-items: flex-start">
            <div class="list-icon">{{ item.icon }}</div>
            <div>
              <div style="font-weight: 600">{{ item.title }}</div>
              <div class="mini-hint" style="margin-top: 2px">{{ item.text }}</div>
            </div>
          </div>
        </GlassCard>
      </div>

      <div class="sheet-actions" style="margin-top: 20px">
        <GlassButton variant="primary" block @click="next">Начать настройку</GlassButton>
      </div>
      <div style="text-align: center; margin-top: 12px">
        <button class="btn-glass btn-sm" @click="skipAll">Пропустить, покажите приложение</button>
      </div>
    </template>

    <!-- Шаг 1-2: Директ и Метрика -->
    <template v-else-if="step === 1 || step === 2">
      <h2 class="mini-title" style="font-size: 24px">
        {{ step === 1 ? 'Подключим Яндекс Директ' : 'Теперь Метрика' }}
      </h2>
      <p class="mini-muted" style="margin: 8px 0 16px">
        {{
          step === 1
            ? 'Директ даёт доступ к кампаниям: читаем статистику, меняем ставки и останавливаем то, что сливает бюджет.'
            : 'Метрика покажет, что происходит с посетителями после клика: визиты, конверсии, отказы. Токен тот же, что для Директа.'
        }}
      </p>

      <GlassCard>
        <div class="mini-row-between">
          <div class="mini-row">
            <div class="list-icon">🎯</div>
            <div>
              <div style="font-weight: 600">{{ step === 1 ? 'Яндекс Директ' : 'Яндекс Метрика' }}</div>
              <div class="mini-hint">
                {{ step === 1 ? (directReady ? 'Подключено' : '~2 минуты: создать приложение и скопировать токен') : metrikaReady ? 'Подключено' : 'Тот же токен + номер счётчика' }}
              </div>
            </div>
          </div>
          <GlassButton size="sm" :variant="(step === 1 ? directReady : metrikaReady) ? 'glass' : 'primary'" @click="openService(step === 1 ? 'yandex-direct' : 'yandex-metrika')">
            {{ (step === 1 ? directReady : metrikaReady) ? 'Проверить' : 'Подключить' }}
          </GlassButton>
        </div>
      </GlassCard>

      <div class="mini-stack" style="margin-top: 14px">
        <div class="glass glass-tight mini-hint">
          🔒 Ключи шифруются на вашем сервере (AES-256) и не покидают его. В интерфейсе видно только начало ключа.
        </div>
        <div v-if="INSTRUCTIONS['yandex-direct'].tips?.length" class="glass glass-tight mini-hint">
          💡 {{ INSTRUCTIONS['yandex-direct'].tips?.[0] }}
        </div>
      </div>

      <div class="sheet-actions" style="margin-top: 20px">
        <GlassButton @click="step -= 1">Назад</GlassButton>
        <GlassButton variant="primary" @click="next">{{ step === 1 && !directReady ? 'Пропустить' : 'Дальше' }}</GlassButton>
      </div>
      <div style="text-align: center; margin-top: 10px">
        <button v-if="step === 1" class="btn-glass btn-sm" @click="step = 2">Токена пока нет — перейти к Метрике</button>
      </div>
    </template>

    <!-- Шаг 3: сайт -->
    <template v-else-if="step === 3">
      <h2 class="mini-title" style="font-size: 24px">Добавим сайт</h2>
      <p class="mini-muted" style="margin: 8px 0 16px">
        Сайт можно добавить с любой платформы: Tilda, WordPress, Vercel, Netlify, GitHub, обычный хостинг. MARK сам определит платформу и предложит способ внесения правок.
      </p>

      <GlassCard class="mini-stack">
        <label class="field">
          <span class="field-label">Адрес сайта</span>
          <input v-model="siteUrl" class="input" type="url" placeholder="https://my-site.ru" autocapitalize="off" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">Название (для отчётов)</span>
          <input v-model="siteName" class="input" type="text" placeholder="Основной сайт" />
        </label>
        <GlassButton variant="primary" block :loading="siteBusy" @click="createSite">Добавить сайт и проверить</GlassButton>
        <div class="mini-hint">После добавления запустится первый аудит: балл SEO, проблемы и готовые автоисправления.</div>
      </GlassCard>

      <div class="sheet-actions" style="margin-top: 16px">
        <GlassButton @click="step -= 1">Назад</GlassButton>
        <GlassButton variant="glass" @click="step = 4">Пропустить</GlassButton>
      </div>
    </template>

    <!-- Шаг 4: запуск -->
    <template v-else>
      <div class="orb-wrap" style="position: relative">
        <GradientOrb :size="240" top="-70px" left="-70px" :opacity="0.45" />
        <h2 class="mini-title" style="font-size: 26px">Всё готово</h2>
      </div>

      <div class="mini-stack" style="margin-top: 12px">
        <div class="glass-row">
          <div>
            <div style="font-weight: 600">Яндекс Директ</div>
            <div class="mini-hint">{{ directReady ? 'подключён' : 'не подключён — можно добавить позже' }}</div>
          </div>
          <span class="badge" :class="directReady ? 'badge-live' : 'badge-warn'">{{ directReady ? 'готово' : 'позже' }}</span>
        </div>
        <div class="glass-row">
          <div>
            <div style="font-weight: 600">Яндекс Метрика</div>
            <div class="mini-hint">{{ metrikaReady ? 'подключена' : 'не подключена' }}</div>
          </div>
          <span class="badge" :class="metrikaReady ? 'badge-live' : 'badge-warn'">{{ metrikaReady ? 'готово' : 'позже' }}</span>
        </div>
        <div class="glass-row">
          <div>
            <div style="font-weight: 600">Сайт</div>
            <div class="mini-hint">{{ siteCreated ? siteUrl : 'не добавлен' }}</div>
          </div>
          <span class="badge" :class="siteCreated ? 'badge-live' : 'badge-warn'">{{ siteCreated ? 'добавлен' : 'позже' }}</span>
        </div>
        <div v-if="detection?.platformName" class="glass glass-tight mini-hint">
          Платформа определена: <b>{{ detection.platformName }}</b>. Автоисправления будут готовы под неё.
        </div>
      </div>

      <GlassCard style="margin-top: 16px">
        <div style="font-weight: 600; margin-bottom: 6px">Что дальше включим автоматически</div>
        <ul class="mini-hint" style="padding-left: 18px; margin: 0">
          <li>аудит сайта — раз в неделю, ночью;</li>
          <li>автооптимизация ставок — каждый день;</li>
          <li>проверка трафика на ботов — по загруженным логам;</li>
          <li>отчёт клиенту — 1-го числа каждого месяца.</li>
        </ul>
      </GlassCard>

      <div class="sheet-actions" style="margin-top: 18px">
        <GlassButton @click="step = 3">Назад</GlassButton>
        <GlassButton variant="success" @click="finish">Готово, открыть дашборд</GlassButton>
      </div>
    </template>
  </div>

  <ServiceSheet :open="sheetOpen" :service="activeServiceId ? services[activeServiceId] ?? null : null" @close="sheetOpen = false" @connected="refreshServices" />
</template>
