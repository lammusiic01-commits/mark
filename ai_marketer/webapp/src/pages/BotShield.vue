<template>
  <div class="shield-page">
    <ScreenHeader title="Ловля ботов" eyebrow="Защита бюджета" back fallback-path="/" />

    <!-- Главный показатель: риск и экономия -->
    <GlassCard class="hero">
      <ProgressRing :value="riskScore" :color="riskColor" :size="182" :stroke="13" caption="риск">
        <span class="risk-number">{{ riskScore }}</span>
        <span class="risk-caption">{{ riskLevel }}</span>
      </ProgressRing>

      <div class="hero-numbers">
        <div class="hero-cell">
          <span class="hero-label">Утекает за месяц</span>
          <b class="hero-value danger">{{ wastedText }}</b>
        </div>
        <div class="hero-cell">
          <span class="hero-label">Вернём экономией</span>
          <b class="hero-value">{{ savingsText }}</b>
        </div>
        <div class="hero-cell">
          <span class="hero-label">Подозрительных визитов</span>
          <b class="hero-value">{{ suspicious }} из {{ number(totalVisits) }}</b>
        </div>
      </div>

      <GlassButton variant="primary" size="lg" block :loading="checking" @click="check">
        {{ hasReport ? 'Проверить снова' : 'Проверить трафик' }}
      </GlassButton>

      <p v-if="checkedAt" class="hero-note">Последняя проверка: {{ timeAgo(checkedAt) }}</p>
    </GlassCard>

    <!-- Пусто: отчёта ещё нет -->
    <EmptyState
      v-if="!hasReport && !checking"
      icon="🛡️"
      title="Ещё не проверяли трафик"
      text="Нажму на данные Метрики: посмотрю визиты, источники и поведение — и найду накрутку."
    />

    <template v-else-if="hasReport">
      <!-- Совет AI -->
      <GlassCard v-if="summary" class="advice">
        <div class="advice-head">
          <GradientOrb :size="36" />
          <h4>Что это значит</h4>
          <span class="source">{{ report.summary_source === 'ai' ? 'модель' : 'расчёт' }}</span>
        </div>
        <p>{{ summary }}</p>
      </GlassCard>

      <!-- Паттерны по критичности -->
      <section v-if="patterns.length" class="section">
        <h3 class="section-title">Что нашёл</h3>
        <GlassCard
          v-for="pattern in patterns"
          :key="pattern.code"
          class="pattern"
          :class="`severity-${pattern.severity}`"
        >
          <div class="pattern-head">
            <span class="pattern-icon">{{ SEVERITY_ICONS[pattern.severity] || '⚠️' }}</span>
            <div class="pattern-titles">
              <h4>{{ pattern.title }}</h4>
              <span class="pattern-meta">
                {{ number(pattern.visits) }} {{ plural(pattern.visits, 'визит', 'визита', 'визитов') }}
                · {{ share(pattern.share_pct) }} визитов
              </span>
            </div>
            <b class="pattern-money">{{ money(pattern.wasted_rub) }}</b>
          </div>

          <p v-if="pattern.reason" class="pattern-reason">{{ pattern.reason }}</p>
          <p v-if="pattern.action" class="pattern-action">→ {{ pattern.action }}</p>
        </GlassCard>
      </section>

      <!-- График по дням -->
      <GlassCard v-if="daily.length" class="chart-card">
        <h4>Активность за 30 дней</h4>
        <p class="chart-sub">Красным — дни с высокой долей подозрительных визитов</p>
        <BarChart :items="daily" />
      </GlassCard>

      <!-- Где именно теряем деньги -->
      <section v-if="atRisk.length" class="section">
        <h3 class="section-title">Где теряем</h3>
        <GlassCard class="at-risk">
          <div v-for="campaign in atRisk" :key="campaign.campaign_id" class="risk-row">
            <div class="risk-titles">
              <span class="risk-name">{{ campaign.name }}</span>
              <span class="risk-meta">{{ number(campaign.suspicious) }} подозрительных визитов</span>
            </div>
            <b class="risk-money">{{ money(campaign.wasted_rub) }}</b>
          </div>
        </GlassCard>
      </section>

      <!-- Что сделать по шагам -->
      <GlassCard v-if="actions.length" class="todo">
        <h4>Что сделать сейчас</h4>
        <ol class="todo-list">
          <li v-for="item in actions" :key="item">{{ item }}</li>
        </ol>
      </GlassCard>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import BarChart from '../components/BarChart.vue'
import EmptyState from '../components/EmptyState.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import GradientOrb from '../components/GradientOrb.vue'
import ProgressRing from '../components/ProgressRing.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import { money, number, plural, share, timeAgo } from '../composables/useFormat'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const haptics = useHaptics()

const SEVERITY_ICONS = { critical: '🔴', warning: '🟠', info: '🔵' }

const report = computed(() => {
  const data = store.botReport
  if (!data?.has_report) return {}
  return data.report || {}
})

const hasReport = computed(() => Boolean(store.botReport?.has_report))
const checking = computed(() => Boolean(store.loading.bots))
const riskScore = computed(() => Number(report.value.risk_score || 0))
const suspicious = computed(() => Number(report.value.suspicious_visits || 0))
const totalVisits = computed(() => Number(report.value.total_visits || 0))
const wastedText = computed(() => money(report.value.wasted_rub || store.botReport?.wasted_text || 0))
const savingsText = computed(() => money(report.value.monthly_savings_rub || store.botReport?.savings_text || 0))
const patterns = computed(() => report.value.patterns || [])
const daily = computed(() => report.value.daily || [])
const atRisk = computed(() => report.value.campaigns_at_risk || [])
const summary = computed(() => report.value.summary || store.botReport?.summary || '')
const checkedAt = computed(() => store.botReport?.created_at || null)

const riskLevel = computed(() => {
  if (!hasReport.value) return 'нет данных'
  if (riskScore.value >= 70) return 'высокий риск'
  if (riskScore.value >= 40) return 'средний риск'
  if (riskScore.value > 0) return 'низкий риск'
  return 'чисто'
})

const riskColor = computed(() => {
  if (riskScore.value >= 70) return 'var(--accent-red)'
  if (riskScore.value >= 40) return 'var(--accent-orange)'
  return 'var(--accent-green)'
})

/** Простые шаги, понятные без объяснений: что нажать прямо сейчас */
const actions = computed(() => {
  const steps = []
  for (const pattern of patterns.value.slice(0, 3)) {
    if (pattern.action) steps.push(pattern.action)
  }
  if (!steps.length && riskScore.value > 0) {
    steps.push('Включите фильтр ботов в Метрике: Настройки → Фильтрация трафика')
  }
  if (steps.length && !steps.some((step) => step.toLowerCase().includes('площадк'))) {
    steps.push('Проверьте отчёт по площадкам в Директе и исключите подозрительные')
  }
  return steps
})

async function check() {
  haptics.medium()
  await store.checkBots()
}

onMounted(async () => {
  await store.loadBotReport()
})
</script>

<style scoped>
.shield-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.hero {
  margin: var(--space-4) var(--space-5) var(--space-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  background: linear-gradient(160deg, rgba(10, 132, 255, 0.12), rgba(255, 69, 58, 0.08));
  border: 1px solid var(--border-subtle);
}

.risk-number {
  font-family: var(--font-display);
  font-size: 46px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.04em;
  line-height: 1;
}

.risk-caption {
  font-size: var(--fs-caption);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}

.hero-numbers {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.hero-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hero-cell:last-child {
  grid-column: span 2;
}

.hero-label {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.hero-value {
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.01em;
}

.hero-value.danger {
  color: var(--accent-orange);
}

.hero-note {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.advice {
  margin: 0 var(--space-5) var(--space-3);
  background: linear-gradient(135deg, rgba(191, 90, 242, 0.10), rgba(10, 132, 255, 0.08));
}

.advice-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.advice-head h4 {
  flex: 1;
  font-size: var(--fs-headline);
}

.source {
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  font-size: 10px;
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.advice p {
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-secondary);
}

.section {
  padding: var(--space-3) var(--space-5) 0;
}

.section-title {
  font-size: var(--fs-title-3);
  margin-bottom: var(--space-3);
}

.pattern {
  margin-bottom: var(--space-3);
  border-left: 3px solid var(--border-strong);
}

.pattern.severity-critical {
  border-left-color: var(--accent-red);
}

.pattern.severity-warning {
  border-left-color: var(--accent-orange);
}

.pattern.severity-info {
  border-left-color: var(--accent-blue);
}

.pattern-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.pattern-icon {
  font-size: 15px;
  line-height: 1.4;
}

.pattern-titles {
  flex: 1;
  min-width: 0;
}

.pattern-titles h4 {
  font-size: var(--fs-body);
  margin-bottom: 3px;
}

.pattern-meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.pattern-money {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-orange);
  white-space: nowrap;
}

.pattern-reason {
  margin-top: var(--space-3);
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.45;
}

.pattern-action {
  margin-top: var(--space-2);
  font-size: var(--fs-caption);
  color: var(--accent-blue);
  line-height: 1.45;
}

.chart-card {
  margin: var(--space-3) var(--space-5) 0;
}

.chart-card h4 {
  font-size: var(--fs-headline);
  margin-bottom: 3px;
}

.chart-sub {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  margin-bottom: var(--space-4);
}

.at-risk {
  padding: var(--space-2) var(--space-4);
}

.risk-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 11px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.risk-row:last-child {
  border-bottom: none;
}

.risk-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.risk-name {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.risk-meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.risk-money {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-orange);
}

.todo {
  margin: var(--space-3) var(--space-5) var(--space-6);
}

.todo h4 {
  font-size: var(--fs-headline);
  margin-bottom: var(--space-3);
}

.todo-list {
  margin-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.45;
}
</style>
