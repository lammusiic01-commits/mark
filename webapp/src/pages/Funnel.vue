<script setup>
import { onMounted, ref, computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { num, pct, shortDate } from '../composables/useFormat.js'
import Card from '../components/ui/Card.vue'
import Tabs from '../components/ui/Tabs.vue'
import Icon from '../components/ui/Icon.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import BarChart from '../components/charts/BarChart.vue'
import LineChart from '../components/charts/LineChart.vue'

const days = ref(14)
const { data, loading, error, run } = useRequest(() => api.get(`/funnel?days=${days.value}`))
watch(days, run)
onMounted(run)

const bars = computed(() => (data.value?.stages || []).map((s) => ({ label: s.label, value: s.value, display: num(s.value) })))
const visitsSeries = computed(() => (data.value?.daily || []).map((d) => d.visits))
const visitLabels = computed(() => (data.value?.daily || []).map((d) => shortDate(d.date)))
</script>

<template>
  <div class="page">
    <div class="row-between">
      <div>
        <div class="page-title">Воронка</div>
        <div class="page-sub">Показы → клики → визиты → конверсии</div>
      </div>
      <Tabs v-model="days" :items="[{ value: 7, label: '7д' }, { value: 14, label: '14д' }, { value: 30, label: '30д' }]" />
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="160" />

    <template v-if="data">
      <Card title="Этапы">
        <BarChart :items="bars" :height="170" />
      </Card>

      <Card title="Конверсии между этапами">
        <div class="list">
          <div v-for="s in data.stages" :key="s.key" class="list-item">
            <div class="grow small">{{ s.label }}</div>
            <div class="num small">{{ s.rate_from_prev === null ? '—' : pct(s.rate_from_prev) }}</div>
          </div>
        </div>
        <div class="notice bottleneck" :class="{ 'notice-error': data.bottleneck }">
          <Icon name="filter" :size="16" />
          <span>{{ data.advice }}</span>
        </div>
      </Card>

      <Card v-if="data.has_metrika" title="Визиты на сайт по дням">
        <LineChart v-if="visitsSeries.length > 1" :values="visitsSeries" :labels="visitLabels" :height="120" />
        <div v-else class="muted small">Нет данных Метрики за период</div>
      </Card>
      <Card v-else>
        <div class="small muted-2">Визиты берутся из Яндекс Метрики. Укажи номер счётчика в подключениях.</div>
        <RouterLink to="/connect" class="link">Подключить Метрику</RouterLink>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.bottleneck { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-3); }
.link { display: inline-block; margin-top: var(--s-2); font-weight: 600; }
</style>
