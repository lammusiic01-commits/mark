<script setup>
import { onMounted, ref, reactive } from 'vue'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { num } from '../composables/useFormat.js'
import { haptic, hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Badge from '../components/ui/Badge.vue'
import Icon from '../components/ui/Icon.vue'
import BottomSheet from '../components/ui/BottomSheet.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const { data, loading, error, run } = useRequest(() => api.get('/hypotheses'))
const open = ref(false)
const editingId = ref(null)
const formError = ref('')
const saving = ref(false)
const form = reactive({ name: '', a_visitors: 0, a_conversions: 0, b_visitors: 0, b_conversions: 0 })

const STATUS = {
  collecting: { tone: 'amber', text: 'Сбор данных' },
  significant: { tone: 'green', text: 'Есть победитель' },
  no_difference: { tone: 'neutral', text: 'Разницы нет' },
}

function openNew() {
  editingId.value = null
  Object.assign(form, { name: '', a_visitors: 0, a_conversions: 0, b_visitors: 0, b_conversions: 0 })
  formError.value = ''
  open.value = true
}

function openEdit(h) {
  editingId.value = h.id
  Object.assign(form, { name: h.name, a_visitors: h.a_visitors, a_conversions: h.a_conversions, b_visitors: h.b_visitors, b_conversions: h.b_conversions })
  formError.value = ''
  open.value = true
}

async function save() {
  saving.value = true
  formError.value = ''
  const body = { ...form, name: form.name.trim() }
  try {
    if (editingId.value) await api.put(`/hypotheses/${editingId.value}`, body)
    else await api.post('/hypotheses', body)
    open.value = false
    hapticNotify('success')
    await run()
  } catch (e) {
    formError.value = e.message
    hapticNotify('error')
  } finally {
    saving.value = false
  }
}

async function remove(h) {
  haptic('medium')
  await api.del(`/hypotheses/${h.id}`)
  await run()
}

function progress(h) {
  const need = h.result.needed_per_arm || 100
  const have = Math.min(h.a_visitors, h.b_visitors)
  return Math.min(100, Math.round((have / need) * 100))
}

onMounted(run)
</script>

<template>
  <div class="page">
    <div class="row-between">
      <div>
        <div class="page-title">A/B тесты</div>
        <div class="page-sub">Значимость по z-тесту долей</div>
      </div>
      <Button variant="primary" size="sm" @click="openNew"><Icon name="plus" :size="14" /> Тест</Button>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="120" :lines="2" />

    <EmptyState v-if="data && !data.length" icon="flask" title="Тестов пока нет"
      text="Добавь варианты A и B с числом посетителей и конверсий. Приложение посчитает победителя." />

    <Card v-for="h in data || []" :key="h.id">
      <div class="row-between">
        <div class="grow ellipsis test-name">{{ h.name }}</div>
        <Badge :tone="STATUS[h.result.status].tone">{{ STATUS[h.result.status].text }}</Badge>
      </div>

      <div class="variants">
        <div class="variant" :class="{ win: h.result.winner === 'A' }">
          <div class="xs muted">Вариант A</div>
          <div class="num value">{{ h.result.cr_a }}%</div>
          <div class="xs muted">{{ num(h.a_conversions) }} из {{ num(h.a_visitors) }}</div>
        </div>
        <div class="variant" :class="{ win: h.result.winner === 'B' }">
          <div class="xs muted">Вариант B</div>
          <div class="num value">{{ h.result.cr_b }}%</div>
          <div class="xs muted">{{ num(h.b_conversions) }} из {{ num(h.b_visitors) }}</div>
        </div>
      </div>

      <div class="small muted-2 verdict">{{ h.result.verdict }}</div>
      <div v-if="h.result.p_value !== null" class="hint">p-value {{ h.result.p_value }}<span v-if="h.result.lift_pct !== null"> · разница {{ h.result.lift_pct > 0 ? '+' : '' }}{{ h.result.lift_pct }}%</span></div>

      <div v-if="h.result.needed_per_arm" class="progress-block">
        <div class="row-between xs muted"><span>Набор выборки</span><span class="num">{{ progress(h) }}%</span></div>
        <ProgressBar :value="progress(h)" :tone="h.result.sample_ok ? 'green' : 'accent'" />
        <div class="hint">Для эффекта +20% нужно ~{{ num(h.result.needed_per_arm) }} на группу</div>
      </div>

      <div class="row card-actions">
        <Button size="sm" @click="openEdit(h)"><Icon name="pencil" :size="13" /> Обновить данные</Button>
        <Button size="sm" variant="ghost" @click="remove(h)"><Icon name="trash" :size="13" /></Button>
      </div>
    </Card>

    <BottomSheet v-model="open" :title="editingId ? 'Данные теста' : 'Новый A/B тест'">
      <Input v-model="form.name" label="Название" placeholder="Заголовок лендинга" />
      <div class="grid-2">
        <Input v-model="form.a_visitors" type="number" inputmode="numeric" label="Посетители A" />
        <Input v-model="form.a_conversions" type="number" inputmode="numeric" label="Конверсии A" />
        <Input v-model="form.b_visitors" type="number" inputmode="numeric" label="Посетители B" />
        <Input v-model="form.b_conversions" type="number" inputmode="numeric" label="Конверсии B" />
      </div>
      <div v-if="formError" class="notice notice-error">{{ formError }}</div>
      <Button variant="primary" block :loading="saving" :disabled="!form.name.trim()" @click="save">Сохранить</Button>
    </BottomSheet>
  </div>
</template>

<style scoped>
.test-name { font-weight: 600; margin-right: var(--s-2); }
.variants { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2); margin: var(--s-3) 0; }
.variant { padding: var(--s-3); border-radius: var(--r-md); background: var(--bg-surface); border: 1px solid var(--card-border); }
.variant.win { border-color: var(--green); }
.value { font-size: var(--text-xl); font-weight: 600; margin: 2px 0; }
.verdict { line-height: 1.5; }
.progress-block { margin-top: var(--s-3); display: flex; flex-direction: column; gap: 6px; }
.card-actions { margin-top: var(--s-3); justify-content: flex-end; }
</style>
