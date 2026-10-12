<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import BarsChart from '../components/BarsChart.vue';
import BottomSheet from '../components/BottomSheet.vue';
import GaugeRing from '../components/GaugeRing.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import { tgApi, type MiniAudit, type MiniGeoAnalysis } from '../api';
import { money, num, percent, severityColor, severityLabel, shortDate, timeAgo } from '../format';
import { select } from '../telegram';
import { toastErr, toastOk } from '../useToasts';
import { go } from '../useMiniapp';

/**
 * Экран роста: сайты, аудит и автоисправления, GEO и рынок.
 *
 * Ключевая идея промта: движок делает работу скриптами, а человек только
 * подтверждает. Поэтому здесь каждая карточка заканчивается кнопкой «применить»,
 * а результат виден сразу: балл SEO, готовые файлы, страницы по регионам.
 */

interface Site {
  id: string;
  name: string;
  url: string;
  platform: string;
  seoScore: number | null;
  lastAuditAt: string | null;
  geoStatus: string | null;
  keywords: string[];
  regions: { id: number; name: string }[];
}

const tab = ref<'audit' | 'geo' | 'market'>('audit');
const sites = ref<Site[]>([]);
const loading = ref(true);
const busy = ref(false);

const audit = ref<MiniAudit | null>(null);
const auditSite = ref<Site | null>(null);
const findingsFilter = ref<'all' | 'autofix'>('all');
interface AutofixFile {
  path: string;
  content: string;
  action: string;
}

const autofixBundle = ref<{ bundle: { files: AutofixFile[] }; summary?: Record<string, unknown> } | null>(null);
const autofixOpen = ref(false);

const geo = ref<MiniGeoAnalysis | null>(null);
const geoKeywords = ref('');
const geoRegionIds = ref<number[]>([213, 2]);
const showAllRegions = ref(false);

interface MiniMarket {
  id: string;
  niche?: string;
  regionName?: string;
  averageCpc?: number;
  yourCpc?: number | null;
  gapPercent?: number | null;
  competition?: number;
  verdict?: string;
  advice?: string[];
  competitors?: { name: string; cpc: number; share: number; note?: string }[];
  budgetPlan?: { scenario: string; dailyBudget: number; clicks: number; conversions: number; cpa: number; note: string }[];
  benchmarks?: { keyword: string; frequency: number; cpc: number; competition: string }[];
}

const market = ref<MiniMarket | null>(null);
const marketForm = reactive({ niche: '', regionId: 213, yourCpc: '', budget: '' });

const newSite = reactive({ open: false, url: '', name: '' });

const REGION_PRESETS = [
  { id: 213, name: 'Москва' },
  { id: 2, name: 'Санкт-Петербург' },
  { id: 54, name: 'Екатеринбург' },
  { id: 43, name: 'Казань' },
  { id: 65, name: 'Новосибирск' },
  { id: 35, name: 'Краснодар' },
  { id: 47, name: 'Нижний Новгород' },
  { id: 239, name: 'Сочи' },
];

onMounted(async () => {
  await loadSites();
  loading.value = false;
});

async function loadSites(): Promise<void> {
  try {
    const response = await tgApi.get<{ items: Site[] }>('/sites');
    sites.value = response.items;
  } catch (error) {
    toastErr('Не удалось загрузить сайты', error instanceof Error ? error.message : String(error));
  }
}

async function addSite(): Promise<void> {
  if (!/^https?:\/\/\S+\.\S+/.test(newSite.url.trim())) {
    toastErr('Проверьте адрес сайта', 'Нужен полный адрес, например https://site.ru');
    return;
  }
  busy.value = true;
  try {
    await tgApi.post('/sites', {
      name: newSite.name.trim() || new URL(newSite.url.trim()).hostname,
      url: newSite.url.trim(),
      regions: geoRegionIds.value,
      keywords: geoKeywords.value ? geoKeywords.value.split(',').map((item) => item.trim()).filter(Boolean) : [],
    });
    toastOk('Сайт добавлен', 'Запустите аудит, чтобы получить балл и исправления');
    newSite.open = false;
    newSite.url = '';
    newSite.name = '';
    await loadSites();
  } catch (error) {
    toastErr('Не удалось добавить сайт', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function runAudit(site: Site): Promise<void> {
  busy.value = true;
  auditSite.value = site;
  audit.value = null;
  try {
    const response = await tgApi.post<{ audit: MiniAudit }>(`/sites/${site.id}/audit`, { maxPages: 20 });
    audit.value = response.audit;
    toastOk('Аудит готов', `Балл ${response.audit.score}/100 · найдено проблем: ${response.audit.findings.length}`);
    await loadSites();
    if (response.audit.simulated) {
      toastErr('Сайт недоступен', 'Проверили по сохранённому слепку: данные приблизительные');
    }
  } catch (error) {
    toastErr('Аудит не прошёл', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

const visibleFindings = computed(() => {
  const list = audit.value?.findings ?? [];
  return findingsFilter.value === 'autofix' ? list.filter((finding) => finding.autoFixable) : list;
});

/** Автоисправления: движок собирает готовые файлы, человек подтверждает. */
async function buildAutofix(): Promise<void> {
  if (!audit.value || !auditSite.value) return;
  const codes = (audit.value.findings ?? []).filter((finding) => finding.autoFixable).map((finding) => finding.code);
  if (!codes.length) {
    toastErr('Нечего исправлять автоматически', 'Все замечания требуют ручной правки');
    return;
  }
  busy.value = true;
  try {
    const response = await tgApi.post<{ bundle: { files: AutofixFile[] }; summary: Record<string, unknown> }>(
      `/sites/${auditSite.value.id}/autofix`,
      { auditRunId: audit.value.id, findingCodes: codes },
    );
    autofixBundle.value = response;
    autofixOpen.value = true;
    select();
  } catch (error) {
    toastErr('Не удалось собрать исправления', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function runGeo(): Promise<void> {
  busy.value = true;
  try {
    const response = await tgApi.post<{ analysis: MiniGeoAnalysis }>('/geo/analyze', {
      keywords: geoKeywords.value ? geoKeywords.value.split(',').map((item) => item.trim()).filter(Boolean) : sites.value[0]?.keywords ?? [],
      regionIds: geoRegionIds.value,
      siteId: sites.value[0]?.id ?? null,
    });
    geo.value = response.analysis;
    toastOk('GEO-анализ готов', `Спрос ${num(response.analysis.totalDemand)} показов в месяц`);
  } catch (error) {
    toastErr('Не удалось посчитать GEO', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function runMarket(): Promise<void> {
  busy.value = true;
  try {
    const response = await tgApi.post<typeof market.value>('/market/analyze', {
      niche: marketForm.niche || sites.value[0]?.keywords?.[0] || 'услуги',
      keywords: geoKeywords.value ? geoKeywords.value.split(',').map((item) => item.trim()).filter(Boolean) : sites.value[0]?.keywords ?? [],
      regionId: marketForm.regionId,
      yourCpc: marketForm.yourCpc ? Number(marketForm.yourCpc) : null,
      budget: marketForm.budget ? Number(marketForm.budget) : null,
    });
    market.value = response;
    toastOk('Анализ рынка готов');
  } catch (error) {
    toastErr('Не удалось проанализировать рынок', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function toggleRegion(id: number): void {
  select();
  geoRegionIds.value = geoRegionIds.value.includes(id) ? geoRegionIds.value.filter((item) => item !== id) : [...geoRegionIds.value, id];
}

const platformName = (site: Site): string => {
  const map: Record<string, string> = {
    tilda: 'Tilda',
    wordpress: 'WordPress',
    bitrix: '1С-Битрикс',
    modx: 'MODX',
    nextjs: 'Next.js',
    nuxt: 'Nuxt',
    astro: 'Astro',
    vercel: 'Vercel',
    netlify: 'Netlify',
    webflow: 'Webflow',
    wix: 'Wix',
    shopify: 'Shopify',
    'static-html': 'статичный HTML',
    unknown: 'платформа не определена',
  };
  return map[site.platform] ?? site.platform;
};
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Рост трафика и позиций</div>
        <h1 class="mini-title">Рост и SEO</h1>
      </div>
      <GlassButton size="sm" variant="primary" @click="newSite.open = true">+ Сайт</GlassButton>
    </header>

    <div class="tabs" style="margin-bottom: 16px">
      <button :class="{ active: tab === 'audit' }" @click="tab = 'audit'">Аудит</button>
      <button :class="{ active: tab === 'geo' }" @click="tab = 'geo'">GEO</button>
      <button :class="{ active: tab === 'market' }" @click="tab = 'market'">Рынок</button>
    </div>

    <LoaderBlock v-if="loading" :rows="3" label="Загружаем сайты" />

    <!-- АУДИТ -->
    <template v-else-if="tab === 'audit'">
      <div v-if="!sites.length" class="glass glass-pad">
        <div class="empty">
          <div class="empty-icon">🌐</div>
          <div style="font-weight: 600">Пока нет сайтов</div>
          <div class="mini-hint">Добавьте сайт — MARK определит платформу и предложит способ внесения правок.</div>
          <GlassButton variant="primary" size="sm" @click="newSite.open = true">Добавить сайт</GlassButton>
        </div>
      </div>

      <GlassCard v-for="site in sites" :key="site.id" style="margin-bottom: 12px">
        <div class="mini-row-between">
          <div style="flex: 1; min-width: 0">
            <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ site.name }}</div>
            <div class="mini-hint">{{ site.url }}</div>
            <div class="mini-row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap">
              <span class="badge">{{ platformName(site) }}</span>
              <span v-if="site.regions?.length" class="badge">{{ site.regions.length }} рег.</span>
              <span v-if="site.lastAuditAt" class="badge">аудит {{ timeAgo(site.lastAuditAt) }}</span>
            </div>
          </div>
          <GaugeRing :value="site.seoScore ?? 0" :size="82" />
        </div>
        <div class="mini-row" style="margin-top: 12px; gap: 8px">
          <GlassButton size="sm" variant="primary" :loading="busy && auditSite?.id === site.id" @click="runAudit(site)">Аудит</GlassButton>
          <GlassButton size="sm" @click="geoKeywords = site.keywords?.join(', ') ?? ''; tab = 'geo'">GEO</GlassButton>
        </div>
      </GlassCard>

      <template v-if="audit">
        <div class="mini-section-title">Результат аудита · {{ audit.score }}/100 · {{ audit.grade }}</div>
        <GlassCard>
          <div class="mini-row" style="gap: 14px">
            <GaugeRing :value="audit.score" :size="96" label="SEO" />
            <div style="flex: 1">
              <div class="mini-row-between"><span class="mini-muted">Критично</span><b style="color: var(--red)">{{ audit.summary.critical }}</b></div>
              <div class="mini-row-between"><span class="mini-muted">Важно</span><b style="color: var(--orange)">{{ audit.summary.high }}</b></div>
              <div class="mini-row-between"><span class="mini-muted">Средне</span><b>{{ audit.summary.medium }}</b></div>
              <div class="mini-row-between"><span class="mini-muted">Можно исправить сами</span><b style="color: var(--green)">{{ audit.summary.autoFixable }}</b></div>
            </div>
          </div>
          <div class="mini-hint" style="margin-top: 10px">
            Проверено страниц: {{ audit.pagesCrawled }}<span v-if="audit.simulated"> · сайт был недоступен, использован сохранённый слепок</span>
          </div>
          <GlassButton
            v-if="audit.summary.autoFixable"
            variant="success"
            block
            style="margin-top: 12px"
            :loading="busy"
            @click="buildAutofix"
          >
            Собрать {{ audit.summary.autoFixable }} автоисправлений
          </GlassButton>
        </GlassCard>

        <div class="mini-row-between" style="margin: 16px 4px 10px">
          <span class="mini-section-title" style="margin: 0">Что нашли</span>
          <div class="tabs" style="width: 190px">
            <button :class="{ active: findingsFilter === 'all' }" @click="findingsFilter = 'all'">Все</button>
            <button :class="{ active: findingsFilter === 'autofix' }" @click="findingsFilter = 'autofix'">Авто</button>
          </div>
        </div>

        <div class="mini-stack">
          <GlassCard v-for="finding in visibleFindings" :key="finding.id" tight>
            <div class="mini-row" style="align-items: flex-start">
              <span class="dot" :style="{ marginTop: '7px', color: severityColor(finding.severity) }" />
              <div style="flex: 1">
                <div style="font-weight: 600">{{ finding.title }}</div>
                <div class="mini-hint" style="margin-top: 2px">{{ finding.recommendation }}</div>
                <div class="mini-row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap">
                  <span class="badge" :style="{ color: severityColor(finding.severity) }">{{ severityLabel(finding.severity) }}</span>
                  <span v-if="finding.autoFixable" class="badge badge-live">исправим сами</span>
                  <span v-if="finding.impact" class="badge">вес {{ finding.impact }}</span>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      </template>
    </template>

    <!-- GEO -->
    <template v-else-if="tab === 'geo'">
      <GlassCard class="mini-stack">
        <label class="field">
          <span class="field-label">Ключевые запросы (через запятую)</span>
          <input v-model="geoKeywords" class="input" placeholder="ремонт квартир, натяжные потолки" />
        </label>
        <div class="field">
          <span class="field-label">Города</span>
          <div class="mini-scroll-x">
            <button
              v-for="region in REGION_PRESETS"
              :key="region.id"
              class="btn-glass btn-sm"
              :class="{ 'btn-primary': geoRegionIds.includes(region.id) }"
              @click="toggleRegion(region.id)"
            >
              {{ region.name }}
            </button>
          </div>
        </div>
        <GlassButton variant="primary" block :loading="busy" @click="runGeo">Посчитать спрос</GlassButton>
        <div class="mini-hint">Движок считает частотность по регионам, цену клика и приоритет входа. AI не нужен — это математика.</div>
      </GlassCard>

      <template v-if="geo">
        <div class="mini-section-title">Спрос по регионам</div>
        <GlassCard>
          <div class="mini-row-between">
            <div>
              <div class="metric-label">Всего показов в месяц</div>
              <div class="metric-value">{{ num(geo.totalDemand) }}</div>
            </div>
            <span class="badge badge-accent">{{ geo.source }}</span>
          </div>
          <div class="mini-stack" style="margin-top: 14px">
            <div v-for="row in showAllRegions ? geo.demandByRegion : geo.demandByRegion.slice(0, 6)" :key="row.regionId">
              <div class="mini-row-between" style="font-size: 13px">
                <span>{{ row.regionName }} <span class="mini-hint">{{ row.priority === 'high' ? '· приоритет' : '' }}</span></span>
                <span class="kpi-value">{{ num(row.demand) }} · CPC {{ money(row.cpc) }}</span>
              </div>
              <div class="progress" style="margin-top: 5px">
                <span :style="{ width: `${Math.min(100, (row.demand / (geo.demandByRegion[0]?.demand || 1)) * 100)}%` }" />
              </div>
            </div>
          </div>
          <GlassButton v-if="geo.demandByRegion.length > 6" size="sm" block style="margin-top: 12px" @click="showAllRegions = !showAllRegions">
            {{ showAllRegions ? 'Свернуть' : `Показать все ${geo.demandByRegion.length}` }}
          </GlassButton>
        </GlassCard>

        <template v-if="geo.seasonality?.length">
          <div class="mini-section-title">Сезонность</div>
          <GlassCard>
            <BarsChart :values="geo.seasonality.map((item) => item.index)" :labels="geo.seasonality.map((item) => item.month)" :max="120" />
          </GlassCard>
        </template>

        <template v-if="geo.recommendations?.length">
          <div class="mini-section-title">Что делать</div>
          <GlassCard>
            <ul class="mini-hint" style="padding-left: 18px; margin: 0; line-height: 1.6">
              <li v-for="item in geo.recommendations" :key="item">{{ item }}</li>
            </ul>
          </GlassCard>
        </template>
      </template>
    </template>

    <!-- РЫНОК -->
    <template v-else>
      <GlassCard class="mini-stack">
        <label class="field">
          <span class="field-label">Ниша</span>
          <input v-model="marketForm.niche" class="input" placeholder="например: стоматология" />
        </label>
        <div class="mini-grid-2">
          <label class="field">
            <span class="field-label">Ваша цена клика, ₽</span>
            <input v-model="marketForm.yourCpc" class="input" inputmode="numeric" placeholder="45" />
          </label>
          <label class="field">
            <span class="field-label">Бюджет в месяц, ₽</span>
            <input v-model="marketForm.budget" class="input" inputmode="numeric" placeholder="150000" />
          </label>
        </div>
        <GlassButton variant="primary" block :loading="busy" @click="runMarket">Сравнить с рынком</GlassButton>
      </GlassCard>

      <template v-if="market">
        <div class="mini-section-title">Рынок</div>
        <div class="mini-grid-2">
          <div class="metric">
            <span class="metric-label">Средняя цена клика</span>
            <span class="metric-value">{{ money(market.averageCpc) }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Конкуренция</span>
            <span class="metric-value">{{ percent((market.competition ?? 0) * 100, 0) }}</span>
          </div>
        </div>

        <div v-if="market.competitors?.length" class="mini-section-title">Кто в рынке</div>
        <GlassCard v-if="market.competitors?.length">
          <div v-for="competitor in market.competitors.slice(0, 6)" :key="competitor.name" style="margin-bottom: 10px">
            <div class="mini-row-between" style="font-size: 13px">
              <span>{{ competitor.name }}</span>
              <span class="kpi-value">CPC {{ money(competitor.cpc) }}</span>
            </div>
            <div class="progress" style="margin-top: 5px"><span :style="{ width: `${Math.min(100, competitor.share * 100)}%` }" /></div>
          </div>
        </GlassCard>

        <template v-if="market.advice?.length">
          <div class="mini-section-title">Выводы движка</div>
          <GlassCard>
            <ul class="mini-hint" style="padding-left: 18px; margin: 0; line-height: 1.6">
              <li v-for="item in market.advice" :key="item">{{ item }}</li>
            </ul>
          </GlassCard>
        </template>
      </template>
    </template>
  </div>

  <!-- Новый сайт -->
  <BottomSheet :open="newSite.open" @close="newSite.open = false">
    <h3 class="mini-title-sm">Новый сайт</h3>
    <p class="mini-hint" style="margin: 6px 0 14px">Подходит любая платформа: Tilda, WordPress, Vercel, Netlify, GitHub Pages, обычный хостинг.</p>
    <div class="mini-stack">
      <label class="field">
        <span class="field-label">Адрес сайта</span>
        <input v-model="newSite.url" class="input" placeholder="https://my-site.ru" autocapitalize="off" autocomplete="off" />
      </label>
      <label class="field">
        <span class="field-label">Название</span>
        <input v-model="newSite.name" class="input" placeholder="Основной сайт" />
      </label>
    </div>
    <div class="sheet-actions">
      <GlassButton @click="newSite.open = false">Отмена</GlassButton>
      <GlassButton variant="primary" :loading="busy" @click="addSite">Добавить</GlassButton>
    </div>
  </BottomSheet>

  <!-- Автоисправления -->
  <BottomSheet :open="autofixOpen" @close="autofixOpen = false">
    <h3 class="mini-title-sm">Готовые исправления</h3>
    <p class="mini-hint" style="margin: 6px 0 14px">
      Движок подготовил {{ autofixBundle?.bundle.files.length ?? 0 }} файлов. Проверьте и примените — MARK внесёт правки через подключённый способ (API платформы, хостинг, репозиторий).
    </p>
    <div class="mini-stack">
      <div v-for="file in autofixBundle?.bundle.files ?? []" :key="file.path" class="glass glass-tight">
        <div class="mini-row-between">
          <span style="font-weight: 600; font-size: 13px">{{ file.path }}</span>
          <span class="badge badge-accent">{{ file.action === 'create' ? 'создать' : file.action === 'update' ? 'обновить' : file.action }}</span>
        </div>
        <pre class="code" style="margin: 8px 0 0; max-height: 160px">{{ file.content.slice(0, 700) }}</pre>
      </div>
    </div>
    <div class="sheet-actions">
      <GlassButton @click="autofixOpen = false">Позже</GlassButton>
      <GlassButton variant="success" @click="autofixOpen = false; toastOk('Файлы сохранены', 'Артефакты доступны в полной версии: раздел «Сайты» → патч')">Применить</GlassButton>
    </div>
  </BottomSheet>
</template>
