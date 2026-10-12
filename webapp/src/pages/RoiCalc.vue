<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { api } from '../composables/useApi.js'
import { rubs, pct, num } from '../composables/useFormat.js'
import Card from '../components/ui/Card.vue'
import Input from '../components/ui/Input.vue'
import Button from '../components/ui/Button.vue'
import Badge from '../components/ui/Badge.vue'

const form = reactive({ budget_rub: 10000, cpc_rub: 20, cr_percent: 3, avg_check_rub: 3000, margin_percent: 30 })
const result = ref(null)
const error = ref('')
const hasData = ref(false)
let timer = null

async function calc() {
  error.value = ''
  try {
    result.value = await api.post('/roi/calc', { ...form })
  } catch (e) {
    result.value = null
    error.value = e.message
  }
}

watch(form, () => {
  clearTimeout(timer)
  timer = setTimeout(calc, 300)
}, { deep: true })

async function prefill() {
  try {
    const d = await api.get('/roi/defaults')
    hasData.value = d.has_data
    if (d.has_data) {
      if (d.cpc_rub > 0) form.cpc_rub = d.cpc_rub
      if (d.cr_percent > 0) form.cr_percent = d.cr_percent
    }
    if (d.budget_rub > 0) form.budget_rub = d.budget_rub
  } catch (_) {
    // без данных калькулятор работает на введённых значениях
  }
}

onMounted(async () => {
  await prefill()
  await calc()
})
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">ROI-калькулятор</div>
      <div class="page-sub">Прогноз по бюджету, цене клика и конверсии</div>
    </div>

    <div v-if="hasData" class="hint">Цена клика и CR подставлены из твоих кампаний за 14 дней. Их можно поменять.</div>

    <Card>
      <div class="grid-2">
        <Input v-model="form.budget_rub" type="number" inputmode="decimal" label="Бюджет, ₽" />
        <Input v-model="form.cpc_rub" type="number" inputmode="decimal" label="Цена клика, ₽" />
        <Input v-model="form.cr_percent" type="number" inputmode="decimal" label="Конверсия, %" />
        <Input v-model="form.avg_check_rub" type="number" inputmode="decimal" label="Средний чек, ₽" />
        <Input v-model="form.margin_percent" type="number" inputmode="decimal" label="Маржа, %" />
      </div>
    </Card>

    <div v-if="error" class="notice notice-error">{{ error }}</div>

    <template v-if="result">
      <div class="grid-2">
        <Card><div class="kpi-label">Прибыль</div><div class="kpi-value" :class="result.profit_rub >= 0 ? 'pos' : 'neg'">{{ rubs(result.profit_rub) }}</div></Card>
        <Card><div class="kpi-label">ROI</div><div class="kpi-value" :class="result.roi_percent >= 0 ? 'pos' : 'neg'">{{ pct(result.roi_percent, 1) }}</div></Card>
        <Card><div class="kpi-label">Кликов</div><div class="kpi-value">{{ num(result.clicks) }}</div></Card>
        <Card><div class="kpi-label">Конверсий</div><div class="kpi-value">{{ num(result.conversions) }}</div></Card>
      </div>

      <Card title="Точки безубыточности">
        <div class="list small">
          <div class="list-item"><span class="grow muted-2">CPA, при котором окупаемость</span><span class="num">{{ rubs(result.breakeven_cpa_rub, 2) }}</span></div>
          <div class="list-item"><span class="grow muted-2">Цена клика, при которой окупаемость</span><span class="num">{{ rubs(result.breakeven_cpc_rub, 2) }}</span></div>
          <div class="list-item"><span class="grow muted-2">Твой CPA</span><span class="num">{{ result.cpa_rub === null ? '—' : rubs(result.cpa_rub, 2) }}</span></div>
        </div>
        <div class="verdict">
          <Badge :tone="result.profit_rub >= 0 ? 'green' : 'red'">{{ result.profit_rub >= 0 ? 'Окупается' : 'Не окупается' }}</Badge>
          <p class="small muted-2">{{ result.verdict }}</p>
        </div>
      </Card>
    </template>

    <Button block @click="calc">Пересчитать</Button>
  </div>
</template>

<style scoped>
.verdict { margin-top: var(--s-3); display: flex; flex-direction: column; gap: var(--s-2); }
.verdict p { margin: 0; line-height: 1.5; }
</style>
