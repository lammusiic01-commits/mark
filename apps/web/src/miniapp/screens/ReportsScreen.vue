<script setup lang="ts">
import { onMounted, ref } from 'vue';
import BottomSheet from '../components/BottomSheet.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import { tgApi, type MiniReport } from '../api';
import { shortDate, statusLabel, statusVariant } from '../format';
import { haptic, openExternal } from '../telegram';
import { toastErr, toastInfo, toastOk } from '../useToasts';

/**
 * Отчёты: движок собирает документ из фактов (аудит, реклама, боты, GEO),
 * а пользователь отправляет его клиенту — либо скачивает, либо открывает
 * HTML-версию под белой меткой агентства.
 */

const items = ref<MiniReport[]>([]);
const loading = ref(true);
const busy = ref(false);
const createOpen = ref(false);
const type = ref<'summary' | 'seo' | 'geo' | 'bot' | 'market' | 'campaigns' | 'hypotheses'>('summary');
const created = ref<{ id: string; title: string; kpis: MiniReport['kpis']; sections: { title: string; paragraphs: string[]; bullets: string[] }[] } | null>(null);

const TYPES: { id: typeof type.value; label: string }[] = [
  { id: 'summary', label: 'Сводный' },
  { id: 'seo', label: 'SEO' },
  { id: 'geo', label: 'GEO' },
  { id: 'bot', label: 'BotShield' },
  { id: 'campaigns', label: 'Кампании' },
  { id: 'hypotheses', label: 'Гипотезы' },
  { id: 'market', label: 'Рынок' },
];

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await tgApi.get<{ items: MiniReport[] }>('/reports');
    items.value = response.items;
  } catch (error) {
    toastErr('Не удалось загрузить отчёты', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  busy.value = true;
  try {
    const response = await tgApi.post<{ report: { id: string; title: string; kpis: MiniReport['kpis']; sections: { title: string; paragraphs: string[]; bullets: string[] }[] } }>(
      '/reports',
      { type: type.value, includeCharts: true, brand: true },
    );
    created.value = response.report;
    haptic('success');
    toastOk('Отчёт собран', 'Проверьте содержание и отправьте клиенту');
    await load();
  } catch (error) {
    toastErr('Не удалось собрать отчёт', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function openReport(report: MiniReport): void {
  openExternal(`${location.origin}/api/tg/reports/${report.id}/html`);
}

function downloadPdf(report: MiniReport): void {
  openExternal(`${location.origin}/api/tg/reports/${report.id}/pdf`);
  toastInfo('PDF формируется', 'Файл откроется в новой вкладке — если сервер без Chromium, скачайте HTML-версию');
}
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Документы для клиентов</div>
        <h1 class="mini-title">Отчёты</h1>
      </div>
      <GlassButton size="sm" variant="primary" @click="createOpen = true">Собрать</GlassButton>
    </header>

    <LoaderBlock v-if="loading" :rows="3" label="Загружаем отчёты" />

    <template v-else>
      <div v-if="!items.length" class="glass glass-pad">
        <div class="empty">
          <div class="empty-icon">📄</div>
          <div style="font-weight: 600">Отчётов пока нет</div>
          <div class="mini-hint">Соберите первый — MARK возьмёт цифры из аудита, кампаний и BotShield.</div>
          <GlassButton variant="primary" size="sm" @click="createOpen = true">Собрать отчёт</GlassButton>
        </div>
      </div>

      <GlassCard v-for="report in items" :key="report.id" style="margin-bottom: 12px">
        <div class="mini-row-between">
          <div style="flex: 1">
            <div style="font-weight: 600">{{ report.title }}</div>
            <div class="mini-hint">{{ report.period }}</div>
          </div>
          <span class="badge" :class="statusVariant(report.status)">{{ statusLabel(report.status) }}</span>
        </div>
        <div v-if="report.kpis?.length" class="mini-grid-2" style="margin-top: 10px">
          <div v-for="kpi in report.kpis.slice(0, 4)" :key="kpi.label" class="metric" style="padding: 10px">
            <span class="metric-label">{{ kpi.label }}</span>
            <span class="metric-value" style="font-size: 16px">{{ kpi.value }}<small v-if="kpi.unit"> {{ kpi.unit }}</small></span>
          </div>
        </div>
        <div class="mini-row" style="gap: 8px; margin-top: 12px">
          <GlassButton size="sm" @click="openReport(report)">Открыть</GlassButton>
          <GlassButton size="sm" @click="downloadPdf(report)">PDF</GlassButton>
          <span class="mini-hint" style="margin-left: auto">{{ shortDate(report.createdAt) }}</span>
        </div>
      </GlassCard>
    </template>
  </div>

  <BottomSheet :open="createOpen" @close="createOpen = false; created = null">
    <h3 class="mini-title-sm">Новый отчёт</h3>
    <p class="mini-hint" style="margin: 6px 0 14px">Отчёт собирается движком из фактических данных — без выдуманных цифр. Оформление берётся из настроек белой метки.</p>

    <div class="tabs" style="margin-bottom: 14px; flex-wrap: wrap">
      <button v-for="item in TYPES" :key="item.id" :class="{ active: type === item.id }" @click="type = item.id">{{ item.label }}</button>
    </div>

    <GlassButton variant="primary" block :loading="busy" @click="create">Собрать отчёт</GlassButton>

    <template v-if="created">
      <div class="mini-section-title">Черновик</div>
      <GlassCard>
        <div style="font-weight: 600">{{ created.title }}</div>
        <div v-for="section in created.sections?.slice(0, 4) ?? []" :key="section.title" style="margin-top: 10px">
          <div style="font-size: 14px; font-weight: 600">{{ section.title }}</div>
          <div v-if="section.paragraphs?.length" class="mini-hint" style="margin-top: 4px">{{ section.paragraphs[0] }}</div>
          <ul v-if="section.bullets?.length" class="mini-hint" style="padding-left: 18px; margin: 6px 0 0">
            <li v-for="bullet in section.bullets.slice(0, 3)" :key="bullet">{{ bullet }}</li>
          </ul>
        </div>
      </GlassCard>
    </template>

    <div class="sheet-actions">
      <GlassButton @click="createOpen = false; created = null">Закрыть</GlassButton>
    </div>
  </BottomSheet>
</template>
