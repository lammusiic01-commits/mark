<script setup>
import { ref, onMounted, reactive } from 'vue'
import { api } from '../composables/useApi.js'
import { hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Icon from '../components/ui/Icon.vue'
import Badge from '../components/ui/Badge.vue'

const form = reactive({
  yandex_token: '',
  metrika_counter_id: '',
  metrika_goal_id: '',
  site_url: '',
})
const current = ref(null)
const status = ref(null)
const busy = reactive({ save: false, direct: false, metrika: false, sync: false })
const message = ref({ type: '', text: '' })

function show(type, text) {
  message.value = { type, text }
  hapticNotify(type === 'ok' ? 'success' : 'error')
}

async function load() {
  current.value = await api.get('/settings')
  form.metrika_counter_id = current.value.metrika_counter_id
  form.metrika_goal_id = current.value.metrika_goal_id
  form.site_url = current.value.site_url
  status.value = await api.get('/services/status')
}

async function save() {
  busy.save = true
  try {
    const payload = {
      metrika_counter_id: form.metrika_counter_id,
      metrika_goal_id: form.metrika_goal_id,
      site_url: form.site_url,
    }
    if (form.yandex_token.trim()) payload.yandex_token = form.yandex_token.trim()
    current.value = await api.put('/settings', payload)
    form.yandex_token = ''
    status.value = await api.get('/services/status')
    show('ok', 'Сохранено. Токен хранится в зашифрованном виде.')
  } catch (e) {
    show('error', e.message)
  } finally {
    busy.save = false
  }
}

async function testDirect() {
  busy.direct = true
  try {
    const r = await api.post('/services/yandex/test')
    show('ok', `Директ отвечает. Кампаний в аккаунте: ${r.campaigns}`)
  } catch (e) {
    show('error', e.message)
  } finally {
    busy.direct = false
  }
}

async function testMetrika() {
  busy.metrika = true
  try {
    const r = await api.post('/services/metrika/test')
    show('ok', `Метрика отвечает. Дней с данными: ${r.days_received}`)
  } catch (e) {
    show('error', e.message)
  } finally {
    busy.metrika = false
  }
}

async function sync() {
  busy.sync = true
  try {
    const r = await api.post('/services/sync', { days: 14 })
    const parts = [`кампаний: ${r.campaigns}`, `строк статистики: ${r.stat_rows}`]
    if (r.metrika_days) parts.push(`дней Метрики: ${r.metrika_days}`)
    show('ok', `Синхронизировано: ${parts.join(', ')}`)
    current.value = await api.get('/settings')
    status.value = await api.get('/services/status')
  } catch (e) {
    show('error', e.message)
  } finally {
    busy.sync = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">Подключения</div>
      <div class="page-sub">Яндекс Директ и Метрика. Ключи шифруются на сервере.</div>
    </div>

    <div v-if="message.text" class="notice" :class="message.type === 'ok' ? 'notice-ok' : 'notice-error'">{{ message.text }}</div>

    <Card title="Статус">
      <div class="stack small">
        <div class="row-between">
          <span>Яндекс Директ</span>
          <Badge :tone="status?.yandex_direct.connected ? 'green' : 'neutral'">{{ status?.yandex_direct.connected ? 'Подключён' : 'Нет токена' }}</Badge>
        </div>
        <div class="row-between">
          <span>Метрика</span>
          <Badge :tone="status?.metrika.connected ? 'green' : 'neutral'">{{ status?.metrika.connected ? 'Подключена' : 'Не настроена' }}</Badge>
        </div>
        <div class="row-between">
          <span>Конверсии из Директа</span>
          <Badge :tone="status?.metrika.goal_id ? 'green' : 'amber'">{{ status?.metrika.goal_id ? `цель ${status.metrika.goal_id}` : 'нужна цель' }}</Badge>
        </div>
      </div>
    </Card>

    <Card title="Яндекс Директ">
      <div class="stack">
        <Input v-model="form.yandex_token" type="password" label="OAuth-токен Директа"
          :placeholder="current?.has_yandex_token ? `Сохранён: ${current.yandex_token_hint}` : 'y0_...'"
          hint="Получить: oauth.yandex.ru, права direct:api. Оставь пустым, чтобы не менять." />
        <Button block :loading="busy.direct" :disabled="!current?.has_yandex_token" @click="testDirect">Проверить токен</Button>
      </div>
    </Card>

    <Card title="Яндекс Метрика">
      <div class="stack">
        <Input v-model="form.metrika_counter_id" label="Номер счётчика" inputmode="numeric" placeholder="12345678" hint="Метрика → Настройки счётчика → Номер счётчика" />
        <Input v-model="form.metrika_goal_id" label="ID цели для конверсий" inputmode="numeric" placeholder="1000001"
          hint="Метрика → Цели. Без цели Директ не отдаёт конверсии, и CPA не считается." />
        <Input v-model="form.site_url" label="Адрес вашего сайта" placeholder="https://example.ru" hint="Для мониторинга доступности и SEO-аудита." />
        <Button block :loading="busy.metrika" :disabled="!current?.has_yandex_token || !form.metrika_counter_id" @click="testMetrika">Проверить Метрику</Button>
      </div>
    </Card>

    <div class="stack">
      <Button variant="primary" block :loading="busy.save" @click="save">
        <Icon name="save" :size="16" /> Сохранить
      </Button>
      <Button block :loading="busy.sync" :disabled="!status?.yandex_direct.connected" @click="sync">
        <Icon name="refresh" :size="16" /> Синхронизировать за 14 дней
      </Button>
    </div>
  </div>
</template>
