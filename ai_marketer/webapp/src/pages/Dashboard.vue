<template>
  <div class="dashboard safe-top">
    <!-- Шапка: приветствие, аватар, обновление -->
    <header class="dash-header">
      <div class="hello-block">
        <p class="hello">{{ greeting || 'Здравствуйте' }}</p>
        <h2>{{ user?.first_name || 'Друг' }}</h2>
      </div>
      <div class="header-actions">
        <button class="round-btn" type="button" aria-label="Обновить" :disabled="loading" @click="refresh">
          <svg :class="{ spin: loading }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" />
          </svg>
        </button>
        <button class="avatar" type="button" @click="goSettings">
          {{ initials }}
        </button>
      </div>
    </header>

    <!-- Сервисы не подключены — объясняем, что делать -->
    <GlassCard v-if="!connected" class="invite" interactive @click="goConnect">
      <div class="invite-head">
        <span class="invite-icon">🔌</span>
        <div>
          <h4>Подключите Директ и Метрику</h4>
          <p>Покажу, сколько стоит заявка, где утекает бюджет и что с этим делать</p>
        </div>
      </div>
      <GlassButton variant="primary" size="md" block>Подключить сервисы</GlassButton>
    </GlassCard>

    <template v-else>
      <!-- Баланс -->
      <GlassCard class="balance-card" interactive @click="goBalance">
        <div class="balance-label">Баланс</div>
        <div class="balance-amount">
          {{ moneyShort(balance).replace(' ₽', '') }}
          <span class="currency">₽</span>
        </div>
        <div class="balance-foot">
          <span v-if="money.days_left" class="balance-note">хватит примерно на {{ Math.round(money.days_left) }} {{ plural(Math.round(money.days_left), 'день', 'дня', 'дней') }}</span>
          <span v-else class="balance-note">{{ money.spent_text }} израсходовано за 30 дней</span>
          <GlassButton variant="secondary" size="sm" @click.stop="goBalance">+ Пополнить</GlassButton>
        </div>
      </GlassCard>

      <!-- Четыре метрики 2×2 -->
      <section class="metrics-grid">
        <MetricCard
          v-for="metric in metrics"
          :key="metric.key"
          :icon="ICONS[metric.key] || '📊'"
          :label="metric.title"
          :value="metric.text"
          :color="COLORS[metric.key]"
        />
      </section>

      <!-- Быстрые действия -->
      <h3 class="section-title">Что делаем</h3>
      <div class="actions-grid">
        <GlassCard class="action" interactive @click="goBotShield">
          <span class="action-emoji">🛡️</span>
          <h4>Ловля ботов</h4>
          <p v-if="shield.has_report">{{ shield.saved_text }} экономии</p>
          <p v-else>Проверить трафик</p>
        </GlassCard>
        <GlassCard class="action" interactive @click="goHypotheses">
          <span class="action-emoji">💡</span>
          <h4>Гипотезы</h4>
          <p v-if="hypotheses.pending">{{ hypotheses.pending }} ждут решения</p>
          <p v-else>Найти точки роста</p>
        </GlassCard>
        <GlassCard class="action" interactive @click="goCampaigns">
          <span class="action-emoji">📈</span>
          <h4>Кампании</h4>
          <p>{{ activeCount }} активных</p>
        </GlassCard>
        <GlassCard class="action" interactive @click="goReports">
          <span class="action-emoji">📋</span>
          <h4>Отчёты</h4>
          <p>Полный разбор</p>
        </GlassCard>
      </div>

      <!-- Сводка экономики -->
      <GlassCard class="summary">
        <div class="summary-row">
          <span>Расход за 30 дней</span>
          <b>{{ money.spent_text }}</b>
        </div>
        <div class="summary-row">
          <span>Заявок получено</span>
          <b>{{ metrics[1]?.text || '0' }}</b>
        </div>
        <div class="summary-row" v-if="profile?.target_cpa_rub">
          <span>Цель по заявке</span>
          <b>{{ moneyExact(profile.target_cpa_rub) }}</b>
        </div>
        <div class="summary-row" v-if="shield.wasted_rub">
          <span>Уходит на ботов</span>
          <b class="danger">{{ shield.saved_text }}</b>
        </div>
      </GlassCard>
    </template>

    <!-- Совет AI -->
    <GlassCard class="ai-tip">
      <div class="ai-tip-head">
        <GradientOrb :size="40" />
        <div class="ai-tip-titles">
          <h4>AI-совет</h4>
          <span class="ai-badge">{{ advice?.source === 'ai' ? 'модель' : 'расчёт' }}</span>
        </div>
      </div>
      <p class="ai-text">{{ advice?.text || 'Данных пока мало — подключите сервисы, и я расскажу, что происходит с бюджетом.' }}</p>
      <button v-if="connected" class="ai-refresh" type="button" :disabled="loadingAdvice" @click="refreshAdvice">
        {{ loadingAdvice ? 'Думаю…' : 'Обновить совет' }}
      </button>
    </GlassCard>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GlassCard from '../components/GlassCard.vue'
import GlassButton from '../components/GlassButton.vue'
import GradientOrb from '../components/GradientOrb.vue'
import MetricCard from '../components/MetricCard.vue'
import { useAppStore } from '../store'
import { useHaptics } from '../composables/useHaptics'
import { moneyExact, moneyShort, plural } from '../composables/useFormat'

const router = useRouter()
const store = useAppStore()
const haptics = useHaptics()

const loadingAdvice = ref(false)

const ICONS = { clicks: '👆', conversions: '🎯', cpa: '💸', cost: '💰' }
const COLORS = {
  clicks: 'rgba(10, 132, 255, 0.15)',
  conversions: 'rgba(48, 209, 88, 0.15)',
  cpa: 'rgba(191, 90, 242, 0.15)',
  cost: 'rgba(255, 159, 10, 0.15)',
}

const user = computed(() => store.dashboard?.user || store.user)
const greeting = computed(() => store.dashboard?.greeting || '')
const money = computed(() => store.dashboard?.money || { balance_text: '0 ₽', spent_text: '0 ₽' })
const metrics = computed(() => store.dashboard?.metrics || [])
const shield = computed(() => store.dashboard?.bot_shield || { has_report: false, saved_text: '0 ₽' })
const hypotheses = computed(() => store.dashboard?.hypotheses || { pending: 0 })
const profile = computed(() => store.dashboard?.profile || store.profile || {})
const advice = computed(() => store.advice || store.dashboard?.advice || null)
const balance = computed(() => Number(money.value.balance_rub || 0))
const connected = computed(() => store.services.connected_count > 0)
const loading = computed(() => Boolean(store.loading.refresh))
const activeCount = computed(() => store.dashboard?.totals?.daily_budget_rub ? 1 : 0)

const initials = computed(() => (user.value?.first_name || 'A').charAt(0).toUpperCase())

async function refresh() {
  haptics.medium()
  await store.refreshAll()
  haptics.success()
}

async function refreshAdvice() {
  haptics.light()
  loadingAdvice.value = true
  await store.loadAdvice()
  loadingAdvice.value = false
  haptics.soft()
}

const goSettings = () => go('/settings')
const goBalance = () => go('/balance')
const goBotShield = () => go('/bot-shield')
const goHypotheses = () => go('/hypotheses')
const goCampaigns = () => go('/campaigns')
const goReports = () => go('/reports')
const goConnect = () => go('/connect')

function go(path) {
  haptics.light()
  router.push(path)
}

onMounted(() => {
  store.loadDashboard()
})
</script>

<style scoped>
.dashboard {
  min-height: 100vh;
  padding: var(--space-3) var(--space-5) calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.dash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-5);
  padding-top: var(--space-3);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.round-btn {
  width: 40px;
  height: 40px;
  padding: 10px;
  border-radius: 50%;
  background: var(--surface-overlay);
  color: var(--text-secondary);
}

.round-btn svg {
  width: 100%;
  height: 100%;
  display: block;
}

.round-btn:disabled {
  opacity: 0.6;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.hello {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.dash-header h2 {
  font-size: var(--fs-title-1);
  margin-top: 2px;
}

.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--gradient-brand);
  color: #fff;
  font-weight: var(--fw-semibold);
  font-size: var(--fs-headline);
  transition: transform var(--duration-fast) var(--ease-spring);
}

.avatar:active {
  transform: scale(0.92);
}

/* Приглашение подключить сервисы */
.invite {
  margin-bottom: var(--space-5);
  background: linear-gradient(135deg, rgba(10, 132, 255, 0.14), rgba(191, 90, 242, 0.10));
  border: 1px solid rgba(10, 132, 255, 0.24);
}

.invite-head {
  display: flex;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.invite-icon {
  font-size: 26px;
  line-height: 1;
}

.invite h4 {
  font-size: var(--fs-headline);
  margin-bottom: 3px;
}

.invite p {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.4;
}

/* Баланс */
.balance-card {
  margin-bottom: var(--space-5);
  background: linear-gradient(135deg, rgba(10, 132, 255, 0.15), rgba(191, 90, 242, 0.10));
  border: 1px solid rgba(10, 132, 255, 0.25);
  padding: var(--space-5);
}

.balance-label {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: var(--fw-medium);
}

.balance-amount {
  font-family: var(--font-display);
  font-size: 44px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
  margin: var(--space-2) 0 var(--space-4);
  line-height: 1;
}

.currency {
  font-size: var(--fs-title-2);
  color: var(--text-secondary);
  margin-left: 4px;
}

.balance-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.balance-note {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}

/* Метрики */
.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
}

/* Действия */
.section-title {
  font-size: var(--fs-title-3);
  margin-bottom: var(--space-4);
}

.actions-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.action { text-align: left; }
.action-emoji { font-size: 28px; display: block; margin-bottom: var(--space-2); }
.action h4 { font-size: var(--fs-body); margin-bottom: 2px; }
.action p { font-size: var(--fs-caption); color: var(--text-secondary); }

/* Сводка */
.summary {
  margin-bottom: var(--space-5);
  padding: var(--space-4) var(--space-4) 6px;
}

.summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 9px 0;
  font-size: var(--fs-footnote);
  border-bottom: 1px solid var(--border-subtle);
}

.summary-row:last-child { border-bottom: none; }
.summary-row span { color: var(--text-secondary); }
.summary-row .danger { color: var(--accent-orange); }

/* Совет AI */
.ai-tip {
  background: linear-gradient(135deg, rgba(191, 90, 242, 0.10), rgba(10, 132, 255, 0.10));
}

.ai-tip-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.ai-tip-titles {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.ai-tip-head h4 { font-size: var(--fs-headline); }

.ai-badge {
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  font-size: 10px;
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.ai-text {
  color: var(--text-secondary);
  line-height: 1.5;
  font-size: var(--fs-footnote);
}

.ai-refresh {
  margin-top: var(--space-3);
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
}

.ai-refresh:disabled {
  color: var(--text-tertiary);
}
</style>
