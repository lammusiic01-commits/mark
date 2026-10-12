<script setup>
import { onMounted, ref, reactive } from 'vue'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { dateTime } from '../composables/useFormat.js'
import { haptic, hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Badge from '../components/ui/Badge.vue'
import Icon from '../components/ui/Icon.vue'
import BottomSheet from '../components/ui/BottomSheet.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const { data, loading, error, run } = useRequest(() => api.get('/competitors'))
const open = ref(false)
const form = reactive({ name: '', url: '' })
const formError = ref('')
const saving = ref(false)
const busyId = ref(null)
const notice = ref({ type: '', text: '' })

async function add() {
  saving.value = true
  formError.value = ''
  try {
    const r = await api.post('/competitors', { ...form })
    open.value = false
    form.name = ''
    form.url = ''
    notice.value = r.check?.ok
      ? { type: 'ok', text: `Конкурент добавлен, страница отвечает (HTTP ${r.check.status})` }
      : { type: 'error', text: `Конкурент добавлен, но страница недоступна: ${r.check?.error || 'HTTP ' + r.check?.status}` }
    hapticNotify(r.check?.ok ? 'success' : 'warning')
    await run()
  } catch (e) {
    formError.value = e.message
    hapticNotify('error')
  } finally {
    saving.value = false
  }
}

async function recheck(c) {
  busyId.value = c.id
  notice.value = { type: '', text: '' }
  try {
    const r = await api.post(`/competitors/${c.id}/check`)
    if (r.check.changed) notice.value = { type: 'ok', text: `«${c.name}»: содержимое страницы изменилось` }
    haptic('light')
    await run()
  } catch (e) {
    notice.value = { type: 'error', text: e.message }
  } finally {
    busyId.value = null
  }
}

async function remove(c) {
  haptic('medium')
  await api.del(`/competitors/${c.id}`)
  await run()
}

onMounted(run)
</script>

<template>
  <div class="page">
    <div class="row-between">
      <div>
        <div class="page-title">Конкуренты</div>
        <div class="page-sub">Статус страниц и изменения контента</div>
      </div>
      <Button variant="primary" size="sm" @click="open = true"><Icon name="plus" :size="14" /> Добавить</Button>
    </div>

    <div v-if="notice.text" class="notice" :class="notice.type === 'ok' ? 'notice-ok' : 'notice-error'">{{ notice.text }}</div>
    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="90" :lines="2" />

    <EmptyState v-if="data && !data.length" icon="globe" title="Конкурентов пока нет"
      text="Добавь адрес страницы конкурента: приложение проверит доступность и сообщит, если контент изменился." />

    <Card v-for="c in data || []" :key="c.id">
      <div class="row-between">
        <div class="grow">
          <div class="comp-name ellipsis">{{ c.name }}</div>
          <div class="xs muted ellipsis">{{ c.url }}</div>
        </div>
        <Badge :tone="c.last_status >= 200 && c.last_status < 400 ? 'green' : c.last_checked_at ? 'red' : 'neutral'">
          {{ c.last_checked_at ? `HTTP ${c.last_status || 'нет ответа'}` : 'не проверен' }}
        </Badge>
      </div>
      <div v-if="c.last_title" class="small muted-2 title-line ellipsis">{{ c.last_title }}</div>
      <div class="row-between meta">
        <div class="xs muted">
          <span v-if="c.changed" class="changed">Изменился контент</span>
          <span v-else>Проверен: {{ dateTime(c.last_checked_at) }}</span>
        </div>
        <div class="row">
          <Button size="sm" :loading="busyId === c.id" @click="recheck(c)"><Icon name="refresh" :size="13" /></Button>
          <Button size="sm" variant="ghost" @click="remove(c)"><Icon name="trash" :size="13" /></Button>
        </div>
      </div>
    </Card>

    <BottomSheet v-model="open" title="Новый конкурент">
      <Input v-model="form.name" label="Название" placeholder="Конкурент" />
      <Input v-model="form.url" label="Адрес страницы" placeholder="https://competitor.ru" />
      <div v-if="formError" class="notice notice-error">{{ formError }}</div>
      <Button variant="primary" block :loading="saving" :disabled="!form.url.trim()" @click="add">Добавить и проверить</Button>
    </BottomSheet>
  </div>
</template>

<style scoped>
.comp-name { font-weight: 600; }
.title-line { margin-top: 6px; }
.meta { margin-top: var(--s-3); }
.changed { color: var(--amber); font-weight: 600; }
</style>
