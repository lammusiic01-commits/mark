<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../composables/useApi.js'
import { dateTime } from '../composables/useFormat.js'
import { haptic, hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Badge from '../components/ui/Badge.vue'
import Gauge from '../components/charts/Gauge.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const url = ref('')
const busy = ref(false)
const error = ref('')
const result = ref(null)
const history = ref([])

const SEV = { error: { tone: 'red', text: 'Критично' }, warning: { tone: 'amber', text: 'Важно' }, info: { tone: 'neutral', text: 'Совет' } }

async function loadHistory() {
  try {
    history.value = await api.get('/seo/history')
  } catch (_) {
    history.value = []
  }
}

async function audit() {
  busy.value = true
  error.value = ''
  haptic('light')
  try {
    result.value = await api.post('/seo/audit', { url: url.value })
    hapticNotify('success')
    await loadHistory()
  } catch (e) {
    error.value = e.message
    hapticNotify('error')
  } finally {
    busy.value = false
  }
}

async function openCheck(item) {
  result.value = await api.get(`/seo/${item.id}`)
}

onMounted(loadHistory)
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">SEO-лаборатория</div>
      <div class="page-sub">Аудит главной страницы: мета-теги, заголовки, мобильная версия</div>
    </div>

    <Card>
      <div class="stack">
        <Input v-model="url" label="Адрес страницы" placeholder="https://example.ru" autocomplete="url" />
        <Button variant="primary" block :loading="busy" :disabled="!url.trim()" @click="audit">Проверить</Button>
        <div v-if="error" class="notice notice-error">{{ error }}</div>
      </div>
    </Card>

    <template v-if="result">
      <Card>
        <div class="gauge-wrap">
          <Gauge :value="result.score" label="SEO-оценка" :size="170" />
        </div>
        <div class="hint center">{{ result.url }}</div>
      </Card>

      <Card title="Найденные проблемы">
        <div v-if="!result.issues.length" class="muted small">Критичных проблем не найдено</div>
        <div v-for="(issue, i) in result.issues" :key="i" class="issue">
          <Badge :tone="SEV[issue.severity].tone">{{ SEV[issue.severity].text }}</Badge>
          <span class="small">{{ issue.message }}</span>
        </div>
      </Card>

      <Card title="Факты со страницы">
        <div class="facts small">
          <div><span class="muted">Title:</span> {{ result.facts.title || '—' }}</div>
          <div><span class="muted">Description:</span> {{ result.facts.description || '—' }}</div>
          <div><span class="muted">H1:</span> {{ result.facts.h1_count }}</div>
          <div><span class="muted">Слов:</span> {{ result.facts.word_count }}</div>
          <div v-if="result.facts.load_ms"><span class="muted">Время загрузки:</span> {{ result.facts.load_ms }} мс</div>
        </div>
      </Card>
    </template>

    <Card title="История проверок">
      <EmptyState v-if="!history.length" icon="search" title="Проверок пока нет" />
      <div v-else class="list">
        <div v-for="item in history" :key="item.id" class="list-item clickable-row" @click="openCheck(item)">
          <div class="grow">
            <div class="ellipsis small">{{ item.url }}</div>
            <div class="xs muted">{{ dateTime(item.created_at) }}</div>
          </div>
          <Badge :tone="item.score >= 80 ? 'green' : item.score >= 50 ? 'amber' : 'red'">{{ item.score }}</Badge>
        </div>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.gauge-wrap { display: flex; justify-content: center; }
.center { text-align: center; margin-top: var(--s-2); }
.issue { display: flex; align-items: flex-start; gap: var(--s-2); padding: 6px 0; border-bottom: 1px solid var(--card-border); }
.issue:last-child { border-bottom: 0; }
.facts { display: flex; flex-direction: column; gap: 6px; word-break: break-word; }
.clickable-row { cursor: pointer; }
</style>
