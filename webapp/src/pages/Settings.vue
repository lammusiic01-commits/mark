<script setup>
import { onMounted, ref, reactive } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { telegramUser } from '../composables/useTelegram.js'
import { hapticNotify } from '../composables/useHaptics.js'
import { markOnboarded } from '../router.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Toggle from '../components/ui/Toggle.vue'
import Avatar from '../components/ui/Avatar.vue'
import Badge from '../components/ui/Badge.vue'
import Icon from '../components/ui/Icon.vue'
import Skeleton from '../components/ui/Skeleton.vue'

const { data, loading, error, run } = useRequest(() => api.get('/settings'))
const form = reactive({ target_cpa_rub: 0, daily_budget_rub: 0, ai_enabled: true, openrouter_key: '' })
const msg = ref({ type: '', text: '' })
const busy = ref(false)
const user = telegramUser()

async function load() {
  const s = await run()
  if (s) {
    form.target_cpa_rub = s.target_cpa_rub
    form.daily_budget_rub = s.daily_budget_rub
    form.ai_enabled = s.ai_enabled
  }
}

async function save() {
  busy.value = true
  msg.value = { type: '', text: '' }
  try {
    const payload = {
      target_cpa_rub: Number(form.target_cpa_rub) || 0,
      daily_budget_rub: Number(form.daily_budget_rub) || 0,
      ai_enabled: form.ai_enabled,
    }
    if (form.openrouter_key.trim()) payload.openrouter_key = form.openrouter_key.trim()
    await api.put('/settings', payload)
    form.openrouter_key = ''
    msg.value = { type: 'ok', text: 'Настройки сохранены' }
    hapticNotify('success')
    await load()
  } catch (e) {
    msg.value = { type: 'error', text: e.message }
    hapticNotify('error')
  } finally {
    busy.value = false
  }
}

async function restartOnboarding() {
  await api.put('/settings', { onboarded: false })
  markOnboarded(false)
  window.location.assign('/onboarding')
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="profile">
      <Avatar :name="user?.first_name || 'Пользователь'" :size="48" />
      <div class="grow">
        <div class="name ellipsis">{{ user?.first_name || 'Пользователь' }} <Badge v-if="data?.is_admin" tone="accent">admin</Badge></div>
        <div class="xs muted">{{ user?.username ? '@' + user.username : 'Telegram' }}</div>
      </div>
    </div>

    <Skeleton v-if="loading && !data" :height="120" />
    <div v-if="error" class="notice notice-error">{{ error }}</div>

    <template v-if="data">
      <Card title="Цели">
        <div class="stack">
          <Input v-model="form.target_cpa_rub" type="number" inputmode="decimal" label="Целевой CPA, ₽" hint="По нему скрипт считает рекомендации по ставкам" />
          <Input v-model="form.daily_budget_rub" type="number" inputmode="decimal" label="Дневной бюджет, ₽" hint="Используется в ROI-калькуляторе" />
        </div>
      </Card>

      <Card title="AI-советник">
        <div class="stack">
          <Toggle v-model="form.ai_enabled" label="Включить AI-комментарии" hint="Скрипт считает всё сам, AI лишь комментирует" />
          <Input v-model="form.openrouter_key" type="password" label="Свой ключ OpenRouter" :placeholder="data.has_openrouter_key ? `Сохранён: ${data.openrouter_key_hint}` : 'sk-or-...'" hint="Без своего ключа каждый AI-совет списывается с баланса" />
          <div class="hint">{{ data.global_ai_available ? 'Общий ключ сервиса доступен' : 'Общий ключ сервиса не настроен' }}</div>
        </div>
      </Card>

      <Card title="Подключения и оплата">
        <div class="links">
          <RouterLink to="/connect" class="link-row">
            <Icon name="plug" :size="16" /><span class="grow">Яндекс Директ и Метрика</span>
            <Badge :tone="data.has_yandex_token ? 'green' : 'neutral'">{{ data.has_yandex_token ? 'подключено' : 'нет' }}</Badge>
            <Icon name="chevron" :size="14" class="muted" />
          </RouterLink>
          <RouterLink to="/balance" class="link-row">
            <Icon name="wallet" :size="16" /><span class="grow">Баланс и пополнение</span>
            <Icon name="chevron" :size="14" class="muted" />
          </RouterLink>
        </div>
      </Card>

      <div v-if="msg.text" class="notice" :class="msg.type === 'ok' ? 'notice-ok' : 'notice-error'">{{ msg.text }}</div>
      <Button variant="primary" block :loading="busy" @click="save"><Icon name="save" :size="16" /> Сохранить</Button>
      <Button variant="ghost" block @click="restartOnboarding">Пройти вводный экран заново</Button>
      <div class="hint center">AI Маркетолог · версия 4.0</div>
    </template>
  </div>
</template>

<style scoped>
.profile { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) 0; }
.name { font-weight: 600; font-size: var(--text-lg); display: flex; align-items: center; gap: 6px; }
.links { display: flex; flex-direction: column; }
.link-row { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) 0; color: var(--text-1); border-bottom: 1px solid var(--card-border); }
.link-row:last-child { border-bottom: 0; }
.center { text-align: center; }
</style>
