<template>
  <div class="campaigns-page">
    <ScreenHeader title="Кампании" eyebrow="Яндекс.Директ">
      <template #action>
        <span class="refresh" :class="{ busy: syncing }">{{ syncing ? '…' : 'Обновить' }}</span>
      </template>
    </ScreenHeader>

    <!-- Сводка по всем кампаниям -->
    <GlassCard v-if="campaigns.length" class="summary">
      <div class="summary-grid">
        <div class="summary-cell">
          <span class="cell-label">Расход за 30 дней</span>
          <b class="cell-value">{{ money(summary.total_cost_rub) }}</b>
        </div>
        <div class="summary-cell">
          <span class="cell-label">Заявок</span>
          <b class="cell-value">{{ decimal(summary.total_conversions) }}</b>
        </div>
        <div class="summary-cell">
          <span class="cell-label">Цена заявки</span>
          <b class="cell-value">{{ money(summary.average_cpa_rub) }}</b>
        </div>
        <div class="summary-cell">
          <span class="cell-label">Бюджет в день</span>
          <b class="cell-value">{{ money(summary.daily_budget_rub) }}</b>
        </div>
      </div>
      <p v-if="updatedAt" class="summary-note">Данные обновлены {{ timeAgo(updatedAt) }}</p>
    </GlassCard>

    <!-- Пустое состояние -->
    <EmptyState
      v-if="!campaigns.length && !loading"
      icon="📈"
      title="Кампаний пока нет"
      text="Подключите Директ и нажмите «Обновить» — подтяну кампании, расход и заявки."
      action="Загрузить данные из Директа"
      :loading="syncing"
      @action="sync"
    />

    <!-- Список кампаний -->
    <GlassCard v-for="campaign in campaigns" :key="campaign.id" class="campaign" interactive @click="open(campaign)">
      <div class="campaign-head">
        <div class="campaign-titles">
          <h4>{{ campaign.name }}</h4>
          <span class="campaign-id">№ {{ campaign.external_id }}</span>
        </div>
        <StatusPill :status="campaign.status" />
      </div>

      <div class="campaign-stats">
        <div class="stat">
          <span>Клики</span>
          <b>{{ number(campaign.stats?.clicks) }}</b>
        </div>
        <div class="stat">
          <span>Расход</span>
          <b>{{ money(campaign.stats?.cost_rub) }}</b>
        </div>
        <div class="stat">
          <span>Заявки</span>
          <b>{{ decimal(campaign.stats?.conversions) }}</b>
        </div>
        <div class="stat">
          <span>Цена заявки</span>
          <b :class="{ warn: isCpaHigh(campaign) }">{{ campaign.stats?.cpa_rub ? money(campaign.stats.cpa_rub) : '—' }}</b>
        </div>
      </div>

      <div class="campaign-foot">
        <button class="toggle" type="button" @click.stop="toggle(campaign)">
          <span class="toggle-track" :class="{ on: campaign.is_active }">
            <span class="toggle-knob" />
          </span>
          {{ campaign.is_active ? 'Работает' : 'На паузе' }}
        </button>
        <span class="campaign-plan">План →</span>
      </div>
    </GlassCard>

    <!-- Карточка кампании -->
    <BottomSheet
      :model-value="Boolean(active)"
      :title="active?.name || ''"
      :subtitle="active ? `№ ${active.external_id} · ${active.status === 'active' ? 'работает' : 'на паузе'}` : ''"
      @update:model-value="close"
    >
      <div v-if="active" class="details">
        <!-- Что предлагает движок -->
        <section class="block">
          <h5>Что предлагаю</h5>

          <div v-if="planLoading" class="plan-loading">Считаю варианты…</div>

          <template v-else-if="plan">
            <div v-if="plan.note" class="plan-note">{{ plan.note }}</div>

            <div v-if="plan.allocation?.rows?.length" class="plan-rows">
              <div v-for="row in plan.allocation.rows" :key="row.channel_id" class="plan-row">
                <div class="plan-row-head">
                  <span class="plan-channel">{{ row.name }}</span>
                  <span class="plan-delta">{{ deltaText(row.delta_pct) }}</span>
                </div>
                <div class="plan-row-body">
                  <span>{{ money(row.current_daily_budget_rub) }} → <b>{{ money(row.planned_daily_budget_rub) }}</b></span>
                </div>
                <p v-if="row.reason" class="plan-reason">{{ row.reason }}</p>
              </div>
            </div>

            <div v-if="plan.bid_plan?.changes?.length" class="bid-changes">
              <div class="bid-title">Ставки: {{ plan.bid_plan.changes.length }} {{ plural(plan.bid_plan.changes.length, 'изменение', 'изменения', 'изменений') }}</div>
              <div v-for="change in plan.bid_plan.changes.slice(0, 8)" :key="change.keyword_id" class="bid-row">
                <span class="bid-phrase">{{ change.phrase }}</span>
                <span class="bid-money">{{ moneyExact(change.current_bid_rub) }} → <b>{{ moneyExact(change.recommended_bid_rub) }}</b></span>
              </div>
              <p v-if="plan.bid_plan.summary?.reason" class="plan-reason">{{ plan.bid_plan.summary.reason }}</p>
            </div>

            <p v-if="!plan.allocation?.rows?.length && !plan.bid_plan" class="plan-note">
              Пока мало данных для рекомендаций: нужно минимум
              {{ plan.allocation?.min_clicks || 20 }} кликов по кампании.
            </p>
          </template>
        </section>

        <!-- Экономика кампании -->
        <section class="block">
          <h5>Экономика</h5>
          <div class="detail-grid">
            <div class="detail-cell">
              <span>Расход</span>
              <b>{{ money(active.stats?.cost_rub) }}</b>
            </div>
            <div class="detail-cell">
              <span>Клики</span>
              <b>{{ number(active.stats?.clicks) }}</b>
            </div>
            <div class="detail-cell">
              <span>CTR</span>
              <b>{{ percent(active.stats?.ctr) }}</b>
            </div>
            <div class="detail-cell">
              <span>Цена клика</span>
              <b>{{ moneyExact(active.stats?.cpc_rub) }}</b>
            </div>
            <div class="detail-cell">
              <span>Заявки</span>
              <b>{{ decimal(active.stats?.conversions) }}</b>
            </div>
            <div class="detail-cell">
              <span>Цена заявки</span>
              <b>{{ active.stats?.cpa_rub ? money(active.stats.cpa_rub) : '—' }}</b>
            </div>
          </div>
        </section>

        <!-- Настройки -->
        <section class="block">
          <h5>Бюджет и цель</h5>
          <FieldInput
            v-model="budgetInput"
            label="Дневной бюджет, ₽"
            inputmode="numeric"
            hint="Изменение уйдёт в Директ сразу после сохранения"
          />
          <FieldInput
            v-model="cpaInput"
            label="Целевая цена заявки, ₽"
            inputmode="numeric"
            hint="На неё ориентируется оптимизатор ставок"
          />
          <GlassButton variant="primary" size="md" block :loading="saving" @click="save">
            Сохранить изменения
          </GlassButton>
        </section>

        <!-- Фразы -->
        <section v-if="keywords.length" class="block">
          <h5>Фразы кампании</h5>
          <div class="keywords">
            <div v-for="row in keywords.slice(0, 15)" :key="row.keyword_id" class="keyword-row">
              <span class="keyword-phrase">{{ row.phrase }}</span>
              <span class="keyword-stats">{{ number(row.clicks) }} кл · {{ money(row.cost_rub) }}</span>
            </div>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="footer-actions">
          <GlassButton variant="primary" size="lg" block :loading="toggling" @click="toggle(active)">
            {{ active?.is_active ? 'Поставить на паузу' : 'Включить кампанию' }}
          </GlassButton>
          <GlassButton variant="ghost" size="md" block @click="refreshPlan">Пересчитать план</GlassButton>
        </div>
      </template>
    </BottomSheet>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import BottomSheet from '../components/BottomSheet.vue'
import EmptyState from '../components/EmptyState.vue'
import FieldInput from '../components/FieldInput.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import StatusPill from '../components/StatusPill.vue'
import { useApi } from '../composables/useApi'
import { decimal, deltaText, money, moneyExact, number, percent, plural, timeAgo } from '../composables/useFormat'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const haptics = useHaptics()
const api = useApi()

const active = ref(null)
const plan = ref(null)
const planLoading = ref(false)
const keywords = ref([])
const saving = ref(false)
const toggling = ref(false)
const budgetInput = ref('')
const cpaInput = ref('')

const campaigns = computed(() => store.campaigns?.campaigns || [])
const summary = computed(() => store.campaigns?.summary || {})
const syncing = computed(() => Boolean(store.loading.sync))
const loading = computed(() => Boolean(store.loading.campaigns))
const updatedAt = computed(() => campaigns.value.find((item) => item.stats_updated_at)?.stats_updated_at || null)

function isCpaHigh(campaign) {
  const cpa = Number(campaign.stats?.cpa_rub || 0)
  const target = Number(campaign.target_cpa || 0)
  return Boolean(cpa && target && cpa > target)
}

async function sync() {
  haptics.medium()
  await store.syncCampaigns()
}

async function toggle(campaign) {
  if (!campaign) return
  toggling.value = true
  haptics.medium()
  const data = await store.toggleCampaign(campaign.id)
  toggling.value = false
  if (data && active.value) {
    active.value = data.campaign
  }
}

async function open(campaign) {
  haptics.light()
  active.value = campaign
  plan.value = null
  keywords.value = []
  budgetInput.value = String(Math.round(campaign.daily_budget || 0))
  cpaInput.value = String(Math.round(campaign.target_cpa || 0))
  await Promise.all([loadPlan(campaign.id), loadDetails(campaign.id)])
}

function close() {
  active.value = null
  plan.value = null
}

async function loadPlan(id) {
  planLoading.value = true
  const data = await store.campaignPlan(id)
  planLoading.value = false
  if (data) plan.value = data
}

async function loadDetails(id) {
  try {
    const data = await api.get(`/campaigns/${id}`)
    keywords.value = data.keywords || []
  } catch {
    keywords.value = []
  }
}

async function refreshPlan() {
  if (!active.value) return
  haptics.light()
  await Promise.all([loadPlan(active.value.id), loadDetails(active.value.id)])
}

async function save() {
  if (!active.value) return
  saving.value = true
  haptics.medium()
  const payload = {}
  const budget = Number(budgetInput.value.replace(/\D/g, ''))
  const cpa = Number(cpaInput.value.replace(/\D/g, ''))
  if (budget && budget !== Math.round(active.value.daily_budget || 0)) payload.daily_budget_rub = budget
  if (cpa !== Math.round(active.value.target_cpa || 0)) payload.target_cpa_rub = cpa

  if (!Object.keys(payload).length) {
    haptics.soft()
    store.pushToast('Ничего не изменилось', 'info')
    saving.value = false
    return
  }

  const data = await store.updateCampaign(active.value.id, payload)
  saving.value = false
  if (data) active.value = data.campaign
}

watch(
  () => store.campaigns?.needs_sync,
  (needsSync) => {
    if (needsSync === false) return
  },
)

onMounted(() => {
  store.loadCampaigns()
})
</script>

<style scoped>
.campaigns-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.refresh {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
}

.refresh.busy {
  color: var(--text-tertiary);
}

.summary {
  margin: var(--space-4) var(--space-5) var(--space-3);
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}

.summary-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cell-label {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.cell-value {
  font-family: var(--font-display);
  font-size: var(--fs-title-3);
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}

.summary-note {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.campaign {
  margin: 0 var(--space-5) var(--space-3);
}

.campaign-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.campaign-titles h4 {
  font-size: var(--fs-headline);
  line-height: 1.3;
  margin-bottom: 3px;
}

.campaign-id {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.campaign-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
  margin: var(--space-4) 0;
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.stat span {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.stat b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat b.warn {
  color: var(--accent-orange);
}

.campaign-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.toggle-track {
  width: 42px;
  height: 25px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  border: 1px solid var(--border-strong);
  padding: 2px;
  transition: background var(--duration-fast) var(--ease-ios);
}

.toggle-track.on {
  background: rgba(48, 209, 88, 0.35);
  border-color: rgba(48, 209, 88, 0.5);
}

.toggle-knob {
  display: block;
  width: 19px;
  height: 19px;
  border-radius: 50%;
  background: #fff;
  transform: translateX(0);
  transition: transform var(--duration-fast) var(--ease-spring);
}

.toggle-track.on .toggle-knob {
  transform: translateX(17px);
}

.campaign-plan {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
}

/* Карточка кампании */
.details {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.block h5 {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

.plan-loading,
.plan-note {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.45;
}

.plan-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.plan-row {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-overlay);
}

.plan-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: 5px;
}

.plan-channel {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.plan-delta {
  font-size: var(--fs-caption);
  font-weight: var(--fw-semibold);
  color: var(--accent-green);
}

.plan-row-body {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.plan-reason {
  margin-top: 6px;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  line-height: 1.45;
}

.bid-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  margin-bottom: var(--space-2);
}

.bid-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-caption);
}

.bid-phrase {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.bid-money {
  white-space: nowrap;
  color: var(--text-secondary);
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.detail-cell {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--surface-overlay);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.detail-cell span {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.detail-cell b {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}

.keywords {
  display: flex;
  flex-direction: column;
}

.keyword-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 9px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--fs-caption);
}

.keyword-phrase {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.keyword-stats {
  color: var(--text-tertiary);
  white-space: nowrap;
}

.footer-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
