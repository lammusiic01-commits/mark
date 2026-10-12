<template>
  <div class="hypotheses-page">
    <ScreenHeader title="Гипотезы" eyebrow="Точки роста">
      <template #action>
        <span class="build" :class="{ busy: building }">{{ building ? '…' : 'Пересобрать' }}</span>
      </template>
    </ScreenHeader>

    <!-- Сколько денег в гипотезах -->
    <GlassCard v-if="pendingCount" class="summary">
      <div class="summary-top">
        <span class="summary-label">Потенциал гипотез</span>
        <b class="summary-value">{{ data.total_impact_text || '0 ₽' }}</b>
      </div>
      <p class="summary-note">
        {{ pendingCount }} {{ plural(pendingCount, 'гипотеза ждёт', 'гипотезы ждут', 'гипотез ждут') }} вашего решения.
        Принимайте по одной — я применю изменения в Директе и проверю результат.
      </p>
    </GlassCard>

    <!-- Фильтр по статусу -->
    <div v-if="data.count" class="filters">
      <button
        v-for="filter in FILTERS"
        :key="filter.value"
        type="button"
        class="filter-btn"
        :class="{ active: activeFilter === filter.value }"
        @click="setFilter(filter.value)"
      >
        {{ filter.label }}
        <span v-if="filter.value === 'pending' && pendingCount" class="filter-count">{{ pendingCount }}</span>
      </button>
    </div>

    <!-- Пусто -->
    <EmptyState
      v-if="!visible.length && !busy"
      icon="💡"
      title="Гипотез пока нет"
      text="Соберу идеи по данным Директа и Метрики: где ставка завышена, какие фразы убыточны, что усилить."
      action="Найти гипотезы"
      :loading="building"
      @action="build"
    />

    <!-- Карточки -->
    <GlassCard
      v-for="item in visible"
      :key="item.id"
      class="card"
      :class="`bucket-${item.bucket}`"
    >
      <div class="card-head">
        <span class="bucket-dot" />
        <div class="card-titles">
          <h4>{{ item.title }}</h4>
          <span class="card-meta">
            {{ item.priority_label }} приоритет · {{ TYPE_TITLES[item.type] || item.type }}
            <template v-if="item.duration_days"> · тест {{ item.duration_days }} {{ plural(item.duration_days, 'день', 'дня', 'дней') }}</template>
          </span>
        </div>
        <b class="card-impact">{{ item.impact_text }}</b>
      </div>

      <p class="card-text">{{ item.description }}</p>
      <p v-if="item.action" class="card-action">→ {{ item.action }}</p>

      <!-- Объяснение от AI-советника -->
      <div v-if="explanations[item.id]" class="card-advice">{{ explanations[item.id] }}</div>

      <div class="card-buttons">
        <template v-if="item.status === 'pending'">
          <GlassButton
            variant="primary"
            size="md"
            :loading="Boolean(store.loading[`decision:${item.id}`])"
            @click="decide(item, 'apply')"
          >
            Запустить
          </GlassButton>
          <GlassButton variant="secondary" size="md" :loading="Boolean(store.loading[`explain:${item.id}`])" @click="explain(item)">
            Объяснить
          </GlassButton>
          <GlassButton variant="ghost" size="md" @click="decide(item, 'reject')">Отклонить</GlassButton>
        </template>
        <template v-else>
          <StatusPill :status="item.status" />
          <span class="card-effect">
            ожидаемый эффект {{ item.expected_impact_pct }} % · {{ item.impact_text }}
          </span>
        </template>
      </div>
    </GlassCard>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import StatusPill from '../components/StatusPill.vue'
import { plural } from '../composables/useFormat'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const haptics = useHaptics()

const FILTERS = [
  { label: 'Ждут решения', value: 'pending' },
  { label: 'Все', value: '' },
  { label: 'В работе', value: 'applied' },
  { label: 'Отклонённые', value: 'rejected' },
]

const TYPE_TITLES = {
  tech: 'техника',
  bids: 'ставки',
  budget: 'бюджет',
  site: 'сайт',
  audience: 'аудитория',
  geo: 'география',
}

const activeFilter = ref('pending')
const explanations = reactive({})

const data = computed(() => store.hypotheses || {})
const building = computed(() => Boolean(store.loading.buildHypotheses))
const busy = computed(() => building.value || Boolean(store.loading.hypotheses))
const pendingCount = computed(() => data.value.pending_count || 0)

/* Порядок задаёт движок — по приоритету; здесь только фильтр по статусу */
const visible = computed(() => {
  const grouped = ['high', 'medium', 'low'].flatMap((bucket) => data.value.groups?.[bucket] || [])
  const all = data.value.hypotheses || []
  const source = grouped.length === all.length ? grouped : all
  if (!activeFilter.value) return source
  return source.filter((item) => item.status === activeFilter.value)
})

async function setFilter(value) {
  haptics.select()
  activeFilter.value = value
  await store.loadHypotheses(value)
}

async function build() {
  haptics.medium()
  await store.buildHypotheses()
  activeFilter.value = 'pending'
}

async function decide(item, action) {
  haptics[action === 'apply' ? 'success' : 'soft']()
  await store.decideHypothesis(item.id, action)
}

async function explain(item) {
  haptics.light()
  if (explanations[item.id]) {
    delete explanations[item.id]
    return
  }
  const result = await store.explainHypothesis(item.id)
  if (result?.advice?.text) explanations[item.id] = result.advice.text
}

onMounted(() => {
  store.loadHypotheses(activeFilter.value)
})
</script>

<style scoped>
.hypotheses-page {
  min-height: 100vh;
  padding-bottom: calc(112px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.build {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-blue);
}

.build.busy {
  color: var(--text-tertiary);
}

.summary {
  margin: var(--space-4) var(--space-5) var(--space-3);
  background: linear-gradient(135deg, rgba(48, 209, 88, 0.12), rgba(10, 132, 255, 0.10));
  border: 1px solid rgba(48, 209, 88, 0.2);
}

.summary-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.summary-label {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.summary-value {
  font-family: var(--font-display);
  font-size: var(--fs-title-1);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
}

.summary-note {
  margin-top: var(--space-3);
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.45;
}

.filters {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5) var(--space-4);
  overflow-x: auto;
  scrollbar-width: none;
}

.filters::-webkit-scrollbar {
  display: none;
}

.filter-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 15px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  transition: all var(--duration-fast) var(--ease-ios);
}

.filter-btn:active {
  transform: scale(0.96);
}

.filter-btn.active {
  background: rgba(10, 132, 255, 0.16);
  border-color: rgba(10, 132, 255, 0.5);
  color: #fff;
}

.filter-count {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--accent-orange);
  color: #000;
  font-size: 10px;
  font-weight: var(--fw-bold);
}

.card {
  margin: 0 var(--space-5) var(--space-3);
  border-left: 3px solid var(--border-strong);
}

.card.bucket-high { border-left-color: var(--accent-green); }
.card.bucket-medium { border-left-color: var(--accent-blue); }
.card.bucket-low { border-left-color: var(--text-tertiary); }

.card-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.bucket-dot {
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--accent-blue);
}

.bucket-high .bucket-dot { background: var(--accent-green); }
.bucket-low .bucket-dot { background: var(--text-tertiary); }

.card-titles {
  flex: 1;
  min-width: 0;
}

.card-titles h4 {
  font-size: var(--fs-headline);
  line-height: 1.3;
  margin-bottom: 3px;
}

.card-meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.card-impact {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-green);
  white-space: nowrap;
}

.card-text {
  margin-top: var(--space-3);
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.5;
}

.card-action {
  margin-top: var(--space-2);
  font-size: var(--fs-caption);
  color: var(--accent-blue);
  line-height: 1.45;
}

.card-advice {
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: rgba(191, 90, 242, 0.10);
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.card-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}

.card-effect {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}
</style>
