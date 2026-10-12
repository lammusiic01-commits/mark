<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../composables/useApi.js'
import { markOnboarded } from '../router.js'
import { telegramUser } from '../composables/useTelegram.js'
import Button from '../components/ui/Button.vue'
import Icon from '../components/ui/Icon.vue'
import Avatar from '../components/ui/Avatar.vue'

const router = useRouter()
const step = ref(0)
const busy = ref(false)
const error = ref('')
const user = telegramUser()
const name = computed(() => user?.first_name || 'друг')

const steps = [
  { icon: 'megaphone', title: 'Подключи Яндекс Директ', text: 'Приложение читает статистику кампаний и показывает, где деньги работают, а где сгорают.' },
  { icon: 'shield', title: 'Ловим накрутку и ботов', text: 'Bot Shield сравнивает CTR, клики и конверсии, и подсвечивает подозрительные кампании.' },
  { icon: 'sparkles', title: 'Решения, а не графики', text: 'Рекомендации по ставкам считает скрипт по целевому CPA. AI-советник только комментирует цифры.' },
]

async function finish() {
  busy.value = true
  error.value = ''
  try {
    await api.put('/settings', { onboarded: true })
    markOnboarded()
    router.replace('/connect')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="onboard page">
    <div class="row">
      <Avatar :name="name" :size="40" />
      <div>
        <div class="muted small">Привет, {{ name }}</div>
        <div class="page-title onboard-title">AI Маркетолог</div>
      </div>
    </div>

    <div class="card onboard-card">
      <div class="icon-tile accent"><Icon :name="steps[step].icon" :size="20" /></div>
      <h2 class="step-title">{{ steps[step].title }}</h2>
      <p class="muted-2 step-text">{{ steps[step].text }}</p>
      <div class="dots" aria-hidden="true">
        <span v-for="(s, i) in steps" :key="i" class="dot" :class="{ on: i === step }"></span>
      </div>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>

    <div class="stack">
      <Button v-if="step < steps.length - 1" variant="primary" block @click="step++">
        Дальше <Icon name="chevron" :size="16" />
      </Button>
      <Button v-else variant="primary" block :loading="busy" @click="finish">Начать настройку</Button>
      <Button v-if="step > 0" variant="ghost" block @click="step--">Назад</Button>
    </div>
  </div>
</template>

<style scoped>
.onboard { padding-top: var(--s-6); min-height: 100%; }
.onboard-title { margin-top: 2px; }
.onboard-card { display: flex; flex-direction: column; gap: var(--s-3); padding: var(--s-6); }
.step-title { font-size: var(--text-xl); font-weight: 600; margin-top: var(--s-2); }
.step-text { margin: 0; line-height: 1.55; }
.dots { display: flex; gap: 6px; margin-top: var(--s-2); }
.dot { width: 6px; height: 6px; border-radius: 3px; background: var(--bg-elevated); transition: width var(--dur) var(--ease), background var(--dur); }
.dot.on { width: 20px; background: var(--accent); }
</style>
