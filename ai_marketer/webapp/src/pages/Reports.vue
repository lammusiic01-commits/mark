<template>
  <div class="reports-page">
    <ScreenHeader title="Отчёты" eyebrow="Разбор рекламы" />

    <!-- Список отчётов -->
    <GlassCard
      v-for="report in reports"
      :key="report.key"
      class="report-row"
      interactive
      @click="openReport(report.key)"
    >
      <span class="report-icon">{{ ICONS[report.key] || '📋' }}</span>
      <div class="report-body">
        <h4>{{ report.title }}</h4>
        <p>{{ report.hint }}</p>
      </div>
      <div class="report-side">
        <span v-if="report.ready && report.highlight" class="report-value">{{ report.highlight }}</span>
        <span class="report-state" :class="{ done: report.ready }">
          {{ report.ready ? 'готов' : 'запустить' }}
        </span>
      </div>
    </GlassCard>

    <!-- Результат последнего запуска -->
    <transition name="fade">
      <GlassCard v-if="result" class="result">
        <div class="result-head">
          <h4>{{ result.title }}</h4>
          <button class="result-close" type="button" @click="result = null">×</button>
        </div>

        <!-- Аудит сайта -->
        <template v-if="result.kind === 'site'">
          <div class="result-score">
            <ProgressRing :value="result.data.audit.score" :size="120" :stroke="10" color="var(--accent-green)" />
            <p class="result-text">{{ result.data.audit.summary }}</p>
          </div>
          <div class="result-rows">
            <div v-for="row in siteRows" :key="row.label" class="result-row">
              <span>{{ row.label }}</span>
              <b>{{ row.value }}</b>
            </div>
          </div>
          <div v-if="result.data.audit.quick_fixes?.length" class="fixes">
            <h5>Что поправить первым делом</h5>
            <p v-for="fix in result.data.audit.quick_fixes.slice(0, 5)" :key="fix.title">→ {{ fix.title }}</p>
          </div>
        </template>

        <!-- География -->
        <template v-else-if="result.kind === 'geo'">
          <p class="result-text">{{ result.data.analysis.summary_text }}</p>
          <div class="result-rows">
            <div v-for="region in result.data.analysis.advices.slice(0, 10)" :key="region.region_code" class="result-row">
              <span>{{ region.region_name }}</span>
              <b :class="toneOf(region.action)">{{ actionTitle(region.action) }} · {{ region.cpa_text || '—' }}</b>
            </div>
          </div>
        </template>

        <!-- Рынок -->
        <template v-else-if="result.kind === 'market'">
          <p class="result-text">{{ result.data.analysis.summary_text }}</p>
          <div class="result-rows">
            <div class="result-row">
              <span>Клик на рынке</span>
              <b>{{ money(result.data.analysis.market_cpc_rub) }}</b>
            </div>
            <div class="result-row">
              <span>Ваш клик</span>
              <b>{{ result.data.analysis.your_cpc_rub ? money(result.data.analysis.your_cpc_rub) : '—' }}</b>
            </div>
            <div class="result-row">
              <span>Конкуренция</span>
              <b>{{ result.data.analysis.competition }}</b>
            </div>
            <div class="result-row">
              <span>План бюджета</span>
              <b>{{ money(result.data.analysis.budget_plan?.recommended_daily_rub || 0) }} в день</b>
            </div>
          </div>
        </template>

        <!-- Защита от ботов -->
        <template v-else-if="result.kind === 'bots'">
          <p class="result-text">{{ result.data.report.summary }}</p>
          <div class="result-rows">
            <div class="result-row">
              <span>Утечка</span>
              <b class="warn">{{ money(result.data.report.wasted_rub) }}</b>
            </div>
            <div class="result-row">
              <span>Экономия в месяц</span>
              <b>{{ money(result.data.report.monthly_savings_rub) }}</b>
            </div>
            <div class="result-row">
              <span>Риск</span>
              <b>{{ result.data.report.risk_score }} из 100</b>
            </div>
          </div>
          <GlassButton variant="secondary" size="md" block @click="goBotShield">Открыть разбор</GlassButton>
        </template>

        <!-- Гипотезы -->
        <template v-else>
          <p class="result-text">{{ result.data.message }}</p>
          <div class="result-rows">
            <div class="result-row">
              <span>Гипотез в ожидании</span>
              <b>{{ result.data.count }}</b>
            </div>
            <div class="result-row">
              <span>Потенциал</span>
              <b>{{ result.data.total_impact_text }}</b>
            </div>
          </div>
          <GlassButton variant="secondary" size="md" block @click="goHypotheses">Открыть гипотезы</GlassButton>
        </template>
      </GlassCard>
    </transition>

    <!-- Профиль бизнеса: без него не будет рыночных ориентиров -->
    <GlassCard class="profile-card">
      <div class="profile-head">
        <h4>О бизнесе</h4>
        <StatusPill :status="profile.niche ? 'connected' : 'disconnected'" />
      </div>
      <div class="profile-rows">
        <div class="result-row">
          <span>Ниша</span>
          <b>{{ profile.niche_title || profile.niche || 'не выбрана' }}</b>
        </div>
        <div class="result-row">
          <span>Регион</span>
          <b>{{ profile.region_name || 'Москва' }}</b>
        </div>
        <div class="result-row">
          <span>Бюджет в месяц</span>
          <b>{{ profile.monthly_budget_rub ? money(profile.monthly_budget_rub) : 'не указан' }}</b>
        </div>
        <div class="result-row">
          <span>Целевая заявка</span>
          <b>{{ profile.target_cpa_rub ? money(profile.target_cpa_rub) : 'не указана' }}</b>
        </div>
      </div>
      <GlassButton variant="secondary" size="md" block @click="goSettings">Заполнить в настройках</GlassButton>
    </GlassCard>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ProgressRing from '../components/ProgressRing.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import StatusPill from '../components/StatusPill.vue'
import { money } from '../composables/useFormat'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const router = useRouter()
const haptics = useHaptics()

const ICONS = { bots: '🛡️', hypotheses: '💡', site: '🌐', geo: '🗺️', market: '📈' }
const ACTIONS = {
  pause: 'остановить',
  decrease: 'снизить ставку',
  increase: 'поднять ставку',
  keep: 'оставить',
  test: 'протестировать',
  expand: 'добавить',
}

const result = ref(null)

const reports = computed(() => store.reports || [])
const profile = computed(() => store.profile || store.dashboard?.profile || {})

const siteRows = computed(() => {
  const audit = result.value?.data?.audit || {}
  return [
    { label: 'Оценка', value: `${audit.score ?? 0} из 100` },
    { label: 'Критичных проблем', value: audit.critical_count ?? 0 },
    { label: 'Скорость ответа', value: audit.facts?.response_ms ? `${audit.facts.response_ms} мс` : '—' },
    { label: 'Мобильная версия', value: audit.facts?.has_viewport ? 'настроена' : 'не найдена' },
    { label: 'Заголовок страницы', value: audit.facts?.title_length ? `${audit.facts.title_length} символов` : '—' },
    { label: 'Счётчик Метрики', value: audit.facts?.has_metrika ? 'есть' : 'не найден' },
  ]
})

function actionTitle(action) {
  return ACTIONS[action] || action || '—'
}

function toneOf(action) {
  if (action === 'pause') return 'warn'
  if (action === 'increase') return 'good'
  return ''
}

async function openReport(key) {
  haptics.medium()
  result.value = null

  if (key === 'bots') {
    await store.loadBotReport()
    if (!store.botReport?.has_report) {
      const data = await store.checkBots()
      if (data) result.value = { kind: 'bots', title: 'Защита от ботов', data }
      return
    }
    router.push('/bot-shield')
    return
  }

  if (key === 'hypotheses') {
    router.push('/hypotheses')
    return
  }

  if (key === 'site') {
    if (!profile.value.site_url) {
      store.pushToast('Сначала укажите адрес сайта в настройках', 'info')
      router.push('/settings')
      return
    }
    const data = await store.runSiteAudit()
    if (data) result.value = { kind: 'site', title: 'Аудит сайта', data }
    return
  }

  if (key === 'geo') {
    const data = await store.runGeo()
    if (data) result.value = { kind: 'geo', title: 'География рекламы', data }
    return
  }

  if (key === 'market') {
    const data = await store.runMarket()
    if (data) result.value = { kind: 'market', title: 'Рынок и конкуренты', data }
  }
}

const goBotShield = () => router.push('/bot-shield')
const goHypotheses = () => router.push('/hypotheses')
const goSettings = () => router.push('/settings')

onMounted(() => {
  store.loadReports()
})
</script>

<style scoped>
.reports-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.report-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-3) var(--space-5) 0;
}

.report-icon {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  background: var(--surface-overlay);
}

.report-body {
  flex: 1;
  min-width: 0;
}

.report-body h4 {
  font-size: var(--fs-body);
  margin-bottom: 2px;
}

.report-body p {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.35;
}

.report-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.report-value {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.report-state {
  font-size: 10px;
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.report-state.done {
  color: var(--accent-green);
}

/* Результат */
.result {
  margin: var(--space-4) var(--space-5) 0;
  border: 1px solid rgba(10, 132, 255, 0.24);
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.result-head h4 {
  font-size: var(--fs-headline);
}

.result-close {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--surface-overlay);
  color: var(--text-secondary);
  font-size: 17px;
  line-height: 1;
}

.result-text {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: var(--space-4);
}

.result-score {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.result-score .result-text {
  margin-bottom: 0;
}

.result-rows {
  display: flex;
  flex-direction: column;
}

.result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-footnote);
}

.result-row:last-child {
  border-bottom: none;
}

.result-row span {
  color: var(--text-secondary);
}

.result-row b {
  font-weight: var(--fw-semibold);
  text-align: right;
}

.result-row b.warn {
  color: var(--accent-orange);
}

.result-row b.good {
  color: var(--accent-green);
}

.fixes {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.fixes h5 {
  font-size: var(--fs-caption);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.fixes p {
  font-size: var(--fs-caption);
  color: var(--accent-blue);
  line-height: 1.45;
}

/* Профиль */
.profile-card {
  margin: var(--space-5) var(--space-5) var(--space-6);
}

.profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.profile-head h4 {
  font-size: var(--fs-headline);
}

.profile-rows {
  margin-bottom: var(--space-4);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-ios);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
