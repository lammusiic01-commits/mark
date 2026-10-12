<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import GaugeRing from '../components/GaugeRing.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import Sparkline from '../components/Sparkline.vue';
import { tgApi, type MiniBotScan } from '../api';
import { money, num, percent, shortDate } from '../format';
import { haptic } from '../telegram';
import { toastErr, toastOk } from '../useToasts';

/**
 * BotShield: считаем фальшивый трафик по логам сервера.
 *
 * Пользователь либо вставляет лог текстом, либо выбирает файл. Движок сам
 * определяет формат (nginx, Apache, JSON, Cloudflare), считает долю ботов,
 * показывает источники и готовит список действий — например, вырезать
 * подсети из показов и отключить ночные часы.
 */

const logContent = ref('');
const format = ref<'auto' | 'nginx' | 'apache' | 'json' | 'cloudflare'>('auto');
const fileName = ref<string | null>(null);
const busy = ref(false);
const scan = ref<MiniBotScan | null>(null);
const history = ref<{ id: string; startedAt: string; cleanlinessScore: number; requests: number; suspicious: number; wastedMoney: number }[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const response = await tgApi.get<{ items: typeof history.value }>('/bots/scans');
    history.value = response.items;
  } catch {
    /* истории может не быть */
  }
  loading.value = false;
});

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toastErr('Файл слишком большой', 'Передайте до 8 МБ — например, один день логов');
    return;
  }
  logContent.value = await file.text();
  fileName.value = file.name;
  toastOk('Файл загружен', `${file.name} · ${Math.round(file.size / 1024)} КБ`);
}

async function run(): Promise<void> {
  if (logContent.value.trim().length < 50) {
    toastErr('Нужен лог', 'Вставьте строки лога или выберите файл');
    return;
  }
  busy.value = true;
  try {
    const response = await tgApi.post<{ scan: MiniBotScan }>('/bots/scan', {
      source: 'upload',
      format: format.value,
      logContent: logContent.value,
    });
    scan.value = response.scan;
    haptic(response.scan.totals.suspiciousRequests / Math.max(response.scan.totals.requests, 1) > 0.15 ? 'warning' : 'success');
    toastOk('Логи проверены', `Подозрительных запросов: ${num(response.scan.totals.suspiciousRequests)}`);
    if (response.scan.errors?.length) toastErr('Замечания парсера', response.scan.errors[0]);
    const historyResponse = await tgApi.get<{ items: typeof history.value }>('/bots/scans');
    history.value = historyResponse.items;
  } catch (error) {
    toastErr('Не удалось обработать лог', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function clearLog(): void {
  logContent.value = '';
  fileName.value = null;
  scan.value = null;
}

const lossPercent = computed(() => {
  if (!scan.value) return 0;
  return (scan.value.totals.suspiciousRequests / Math.max(scan.value.totals.requests, 1)) * 100;
});

const verdict = computed(() => {
  if (!scan.value) return { title: '', text: '', badge: '' };
  const percentValue = lossPercent.value;
  if (percentValue > 20) return { title: 'Трафик сильно засорён', text: 'Больше пятой части запросов — боты. Это прямые потери бюджета.', badge: 'badge-danger' };
  if (percentValue > 8) return { title: 'Ботов больше нормы', text: 'Стоит отключить подсети и ночные показы — вернёте часть бюджета.', badge: 'badge-warn' };
  return { title: 'Трафик чистый', text: 'Доля подозрительных запросов в пределах нормы. Держите проверку раз в неделю.', badge: 'badge-live' };
});
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Защита от фальшивого трафика</div>
        <h1 class="mini-title">BotShield</h1>
      </div>
      <GlassButton v-if="scan" size="sm" @click="clearLog">Сбросить</GlassButton>
    </header>

    <template v-if="!scan">
      <GlassCard class="mini-stack">
        <label class="field">
          <span class="field-label">Файл лога сервера</span>
          <input class="input" type="file" accept=".log,.txt,.json,.csv" @change="onFile" />
          <span class="mini-hint">{{ fileName ? `Загружен: ${fileName}` : 'Подойдёт access.log за день — из nginx, Apache, Cloudflare или JSON-выгрузки' }}</span>
        </label>
        <label class="field">
          <span class="field-label">Или вставьте строки лога</span>
          <textarea v-model="logContent" class="textarea" placeholder="185.44.12.7 - - [12/Oct/2026:03:14:02 +0300] &quot;GET / HTTP/1.1&quot; 200 4523 &quot;-&quot; &quot;Mozilla/5.0 (compatible; SemrushBot/7~bl)&quot;" />
        </label>
        <div class="field">
          <span class="field-label">Формат</span>
          <div class="tabs">
            <button :class="{ active: format === 'auto' }" @click="format = 'auto'">Авто</button>
            <button :class="{ active: format === 'nginx' }" @click="format = 'nginx'">nginx</button>
            <button :class="{ active: format === 'apache' }" @click="format = 'apache'">Apache</button>
            <button :class="{ active: format === 'json' }" @click="format = 'json'">JSON</button>
          </div>
        </div>
        <GlassButton variant="primary" block :loading="busy" @click="run">Проверить трафик</GlassButton>
        <div class="mini-hint">Лог обрабатывается на вашем сервере: ни строки не уходит наружу. Хранится только результат.</div>
      </GlassCard>

      <template v-if="history.length">
        <div class="mini-section-title">Прошлые проверки</div>
        <GlassCard v-for="item in history" :key="item.id" tight style="margin-bottom: 8px">
          <div class="mini-row-between">
            <div>
              <div style="font-weight: 600">{{ shortDate(item.startedAt) }}</div>
              <div class="mini-hint">{{ num(item.requests) }} запросов · подозрительных {{ num(item.suspicious) }}</div>
            </div>
            <span class="badge" :class="item.cleanlinessScore >= 85 ? 'badge-live' : 'badge-warn'">{{ item.cleanlinessScore }}/100</span>
          </div>
        </GlassCard>
      </template>
    </template>

    <LoaderBlock v-if="loading && !scan" :rows="2" />

    <template v-else-if="scan">
      <GlassCard>
        <div class="mini-row" style="gap: 16px">
          <GaugeRing :value="scan.cleanlinessScore" :size="104" label="чистота" />
          <div style="flex: 1">
            <div class="mini-row-between" style="margin-bottom: 4px">
              <span class="badge" :class="verdict.badge">{{ verdict.title }}</span>
            </div>
            <div class="mini-hint">{{ verdict.text }}</div>
            <div class="mini-hint" style="margin-top: 6px">Потери из-за ботов: <b style="color: var(--orange)">{{ money(scan.totals.wastedMoneyEstimate) }}</b></div>
          </div>
        </div>
      </GlassCard>

      <div class="mini-grid-2" style="margin-top: 12px">
        <div class="metric">
          <span class="metric-label">Запросов</span>
          <span class="metric-value">{{ num(scan.totals.requests) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Подозрительных</span>
          <span class="metric-value" style="color: var(--orange)">{{ percent(lossPercent) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Уникальных IP</span>
          <span class="metric-value">{{ num(scan.totals.uniqueIps) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Потери</span>
          <span class="metric-value" style="font-size: 18px">{{ money(scan.totals.wastedMoneyEstimate, { compact: true }) }}</span>
        </div>
      </div>

      <template v-if="scan.series?.length">
        <div class="mini-section-title">Запросы по дням</div>
        <GlassCard>
          <Sparkline :points="scan.series.map((point) => point.value)" :height="80" color="#FF9F0A" />
          <div class="mini-row-between mini-hint" style="margin-top: 6px">
            <span>{{ shortDate(scan.series[0]?.date ?? '') }}</span>
            <span>{{ shortDate(scan.series[scan.series.length - 1]?.date ?? '') }}</span>
          </div>
        </GlassCard>
      </template>

      <template v-if="scan.topBots?.length">
        <div class="mini-section-title">Кто приходил</div>
        <GlassCard>
          <div v-for="bot in scan.topBots.slice(0, 8)" :key="bot.name" class="mini-row-between" style="padding: 6px 0">
            <span style="font-size: 13px">{{ bot.name }}</span>
            <span class="badge" :class="bot.suspicious ? 'badge-danger' : ''">{{ num(bot.requests) }}</span>
          </div>
        </GlassCard>
      </template>

      <template v-if="scan.topIps?.length">
        <div class="mini-section-title">Подозрительные адреса</div>
        <GlassCard>
          <div v-for="ip in scan.topIps.slice(0, 10)" :key="ip.ip" style="padding: 6px 0; border-bottom: 1px solid var(--border)">
            <div class="mini-row-between">
              <span class="code" style="padding: 3px 8px">{{ ip.ip }}</span>
              <span class="mini-hint">{{ ip.country ?? '—' }} · {{ num(ip.suspicious || ip.requests) }} запросов</span>
            </div>
            <div v-if="ip.reason" class="mini-hint" style="margin-top: 4px">{{ ip.reason }}</div>
          </div>
        </GlassCard>
      </template>

      <template v-if="scan.recommendations?.length">
        <div class="mini-section-title">Что сделать</div>
        <div class="mini-stack">
          <GlassCard v-for="item in scan.recommendations" :key="item.title" tight>
            <div style="font-weight: 600">{{ item.title }}</div>
            <div class="mini-hint" style="margin-top: 3px">{{ item.detail }}</div>
          </GlassCard>
        </div>
      </template>

      <div class="sheet-actions">
        <GlassButton block @click="clearLog">Проверить другой лог</GlassButton>
      </div>
    </template>
  </div>
</template>
