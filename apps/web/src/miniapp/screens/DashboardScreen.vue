<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import GaugeRing from '../components/GaugeRing.vue';
import GradientOrb from '../components/GradientOrb.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import MetricCard from '../components/MetricCard.vue';
import Sparkline from '../components/Sparkline.vue';
import { tgApi, type MiniSummary } from '../api';
import { money, num, percent } from '../format';
import { press } from '../telegram';
import { toastOk } from '../useToasts';
import { agencyName, go, refreshSummary, summary, userName } from '../useMiniapp';

/**
 * Дашборд — главный экран приложения.
 *
 * Порядок блоков повторяет логику руководителя агентства: сколько денег,
 * что с рекламой, всё ли чисто с трафиком, что говорит советник и что
 * требует действия прямо сейчас.
 */

const loading = ref(false);
const adviceBusy = ref(false);
const advice = ref<string>(summary.value?.ai_tip ?? '');
const trendPoints = ref<number[]>([]);

onMounted(async () => {
  loading.value = true;
  const data = await refreshSummary();
  if (data) {
    advice.value = data.ai_tip;
    await loadTrend();
  }
  loading.value = false;
});

async function loadTrend(): Promise<void> {
  try {
    const response = await tgApi.get<{ items: { trend: { value: number }[] }[] }>('/campaigns');
    // Складываем клики по дням: ряды у кампаний одинаковой длины (14 дней)
    const length = Math.max(...response.items.map((item) => item.trend?.length ?? 0), 0);
    const series: number[] = [];
    for (let index = 0; index < length; index += 1) {
      let sum = 0;
      for (const campaign of response.items) sum += Number(campaign.trend?.[index]?.value ?? 0);
      series.push(sum);
    }
    trendPoints.value = series;
  } catch {
    trendPoints.value = [];
  }
}

const metrics = computed(() => summary.value?.metrics ?? null);

/** Что требуют внимания — статусы с действиями. */
const alerts = computed(() => summary.value?.alerts ?? []);

async function askAdvisor(): Promise<void> {
  adviceBusy.value = true;
  try {
    const response = await tgApi.post<{ text: string; fromAi: boolean; model?: string }>('/advisor', {
      topic: 'dashboard',
      data: {
        seoScore: metrics.value?.seo_score ?? 0,
        botPercentage: metrics.value?.bot_pct ?? 0,
        balance: summary.value?.balance ?? 0,
        clicks: metrics.value?.clicks ?? 0,
        spent: metrics.value?.spent ?? 0,
        conversions: metrics.value?.conversions ?? 0,
        hypotheses: summary.value?.hypotheses_count ?? 0,
        alerts: alerts.value.map((alert) => alert.code),
      },
    });
    advice.value = response.text;
    toastOk(response.fromAi ? 'Совет готов' : 'Совет собран движком', response.model ?? undefined);
  } catch {
    /* оставляем прежний текст — экран не должен пустеть */
  } finally {
    adviceBusy.value = false;
  }
}

const QUICK_ACTIONS = [
  { id: 'growth', icon: '🔍', title: 'Аудит сайта', text: 'Проверить SEO и получить исправления' },
  { id: 'bots', icon: '🛡', title: 'BotShield', text: 'Посчитать ботов в логах' },
  { id: 'hypotheses', icon: '🧪', title: 'Гипотезы', text: 'Найти точки роста' },
  { id: 'campaigns', icon: '🎯', title: 'Кампании', text: 'Ставки и бюджеты' },
  { id: 'reports', icon: '📄', title: 'Отчёт', text: 'Собрать для клиента' },
  { id: 'balance', icon: '💳', title: 'Пополнить', text: 'Баланс и тарифы' },
] as const;

function alertAction(alert: { action?: string }): void {
  const map: Record<string, 'growth' | 'bots' | 'balance' | 'hypotheses' | 'campaigns'> = {
    autofix: 'growth',
    'bot-shield': 'bots',
    balance: 'balance',
    hypotheses: 'hypotheses',
  };
  const target = alert.action ? map[alert.action] : undefined;
  if (target) go(target);
}
</script>

<template>
  <div class="mini-screen">
    <div class="orb-wrap">
      <GradientOrb :size="230" top="-90px" left="-70px" :opacity="0.4" />
      <header class="mini-header" style="position: relative">
        <div>
          <div class="mini-greeting">{{ agencyName }} · {{ userName }}</div>
          <h1 class="mini-title">Сводка</h1>
        </div>
        <GlassButton size="sm" @click="refreshSummary().then(loadTrend)">Обновить</GlassButton>
      </header>
    </div>

    <LoaderBlock v-if="loading && !summary" :rows="3" label="Считаем данные агентства" />

    <template v-else-if="summary">
      <!-- Баланс и тариф -->
      <GlassCard tight>
        <div class="mini-row-between">
          <div>
            <div class="mini-greeting">Баланс</div>
            <div style="font-size: 26px; font-weight: 700; letter-spacing: -0.6px">{{ money(summary.balance) }}</div>
            <div class="mini-hint">
              {{ summary.plan ? `тариф «${summary.plan}»` : 'тариф не выбран' }}<template v-if="summary.charged30d"> · за 30 дней {{ money(summary.charged30d, { compact: true }) }}</template>
            </div>
          </div>
          <GlassButton variant="primary" size="sm" @click="go('balance')">Пополнить</GlassButton>
        </div>
      </GlassCard>

      <!-- Метрики -->
      <div class="mini-section-title">Реклама за 7 дней</div>
      <div class="mini-grid-2">
        <MetricCard label="Клики" :value="num(metrics?.clicks)" :delta="metrics?.clicks_change" />
        <MetricCard label="Расход" :value="money(metrics?.spent, { compact: true })" :delta="metrics?.spent_change" />
        <MetricCard label="Конверсии" :value="num(metrics?.conversions)" :delta="metrics?.conv_change" />
        <MetricCard label="Боты" :value="percent(metrics?.bot_pct)" :delta="metrics?.bot_change" />
      </div>

      <!-- Динамика -->
      <GlassCard style="margin-top: 12px">
        <div class="mini-row-between">
          <div>
            <div style="font-weight: 600">Динамика кликов</div>
            <div class="mini-hint">Последние 14 дней</div>
          </div>
          <span class="badge badge-accent">{{ num(metrics?.clicks) }} кликов</span>
        </div>
        <Sparkline :points="trendPoints.length ? trendPoints : [4, 6, 5, 8, 7, 10, 9, 12, 11, 13, 12, 15, 14, 16]" :height="84" />
      </GlassCard>

      <!-- Что требует внимания -->
      <template v-if="alerts.length">
        <div class="mini-section-title">Требует внимания</div>
        <div class="mini-stack">
          <GlassCard v-for="alert in alerts" :key="alert.code" tight>
            <div class="mini-row" style="align-items: flex-start">
              <span
                class="dot"
                :style="{ marginTop: '7px', color: alert.severity === 'critical' ? 'var(--red)' : alert.severity === 'high' ? 'var(--orange)' : 'var(--accent)' }"
              />
              <div style="flex: 1">
                <div style="font-weight: 600">{{ alert.title }}</div>
                <div class="mini-hint" style="margin-top: 2px">{{ alert.detail }}</div>
              </div>
              <GlassButton v-if="alert.action" size="sm" @click="alertAction(alert)">Открыть</GlassButton>
            </div>
          </GlassCard>
        </div>
      </template>

      <!-- AI-советник -->
      <div class="mini-section-title">AI-советник</div>
      <GlassCard>
        <div class="mini-row-between" style="margin-bottom: 8px">
          <span class="badge badge-accent">OpenRouter · бесплатные модели</span>
          <GlassButton size="sm" :loading="adviceBusy" @click="askAdvisor">Обновить совет</GlassButton>
        </div>
        <p style="margin: 0; white-space: pre-line; font-size: 14px; line-height: 1.5">{{ advice || 'Нажмите «Обновить совет» — подскажу, что сделать первым.' }}</p>
      </GlassCard>

      <!-- SEO-балл -->
      <div class="mini-section-title">Здоровье сайта</div>
      <GlassCard>
        <div class="mini-row" style="gap: 16px">
          <GaugeRing :value="metrics?.seo_score ?? 0" :size="104" label="SEO" />
          <div style="flex: 1">
            <div style="font-weight: 600">
              {{ (metrics?.seo_score ?? 0) >= 80 ? 'Сайт в порядке' : (metrics?.seo_score ?? 0) >= 60 ? 'Есть что улучшить' : 'Нужен аудит и исправления' }}
            </div>
            <div class="mini-hint" style="margin: 4px 0 10px">
              Сайтов: {{ summary.sites_count }} · активных кампаний: {{ summary.campaigns_count }} · гипотез в очереди: {{ summary.hypotheses_count }}
            </div>
            <GlassButton size="sm" variant="primary" @click="go('growth')">Открыть аудит</GlassButton>
          </div>
        </div>
      </GlassCard>

      <!-- Быстрые действия -->
      <div class="mini-section-title">Быстрые действия</div>
      <div class="mini-grid-2">
        <GlassCard v-for="action in QUICK_ACTIONS" :key="action.id" tight>
          <button
            style="all: unset; display: block; width: 100%; cursor: pointer"
            @click="press(), go(action.id as 'growth')"
          >
            <div class="list-icon" style="margin-bottom: 8px">{{ action.icon }}</div>
            <div style="font-weight: 600">{{ action.title }}</div>
            <div class="mini-hint" style="margin-top: 2px">{{ action.text }}</div>
          </button>
        </GlassCard>
      </div>

      <div style="height: 8px" />
      <GlassButton block @click="go('connect')">Подключить ещё сервис</GlassButton>
    </template>

    <GlassCard v-else>
      <div class="empty">
        <div class="empty-icon">📡</div>
        <div style="font-weight: 600">Данные не загрузились</div>
        <div class="mini-hint">Проверьте, что сервер MARK запущен и доступен по сети.</div>
        <GlassButton variant="primary" size="sm" @click="refreshSummary()">Повторить</GlassButton>
      </div>
    </GlassCard>
  </div>
</template>
