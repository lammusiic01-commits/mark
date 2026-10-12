/*
  Единственное место, где хранятся данные приложения.
  Экраны читают состояние отсюда и вызывают действия — так данные не
  расходятся между страницами (например, баланс после оплаты обновляется
  сразу и в шапке, и на экране «Баланс»).
*/
import { defineStore } from 'pinia'
import { useApi, ensureAccess, hasAccess, saveAccessToken } from '../composables/useApi'
import { saveDevUser } from '../composables/useTelegram'

const api = useApi()

/** Достаёт короткое сообщение об ошибке — что показать пользователю. */
function reason(error) {
  return error?.message || 'Не получилось — попробуйте ещё раз'
}

export const useAppStore = defineStore('app', {
  state: () => ({
    ready: false,
    offline: false,
    loading: {},
    user: null,
    profile: null,
    dashboard: null,
    services: { services: [], connected_count: 0, ready: false },
    campaigns: { campaigns: [], summary: {}, needs_sync: true, count: 0 },
    botReport: null,
    hypotheses: { hypotheses: [], groups: { high: [], medium: [], low: [] }, pending_count: 0 },
    balance: { balance: 0, balance_text: '0 ₽', presets: [1000, 3000, 5000, 10000], history: [] },
    reports: [],
    advice: null,
    onboarding: null,
    payment: null,
    toasts: [],
    lastError: '',
  }),

  getters: {
    /** Есть ли данные для главного экрана (иначе показываем приглашение). */
    hasData: (state) => Boolean(state.dashboard?.totals?.clicks),
    isConnected: (state) => state.services.connected_count > 0,
    userInitial: (state) => (state.user?.first_name || 'A').charAt(0).toUpperCase(),
    pendingHypotheses: (state) => state.hypotheses.pending_count || 0,
    money: (state) => state.dashboard?.money || { balance_text: '0 ₽' },
  },

  actions: {
    /* ───────────────────────── Уведомления ───────────────────────── */

    pushToast(text, kind = 'info') {
      const id = Date.now() + Math.random()
      this.toasts = [...this.toasts, { id, text, kind }]
      setTimeout(() => {
        this.toasts = this.toasts.filter((item) => item.id !== id)
      }, kind === 'error' ? 5200 : 3200)
    },

    dropToast(id) {
      this.toasts = this.toasts.filter((item) => item.id !== id)
    },

    /** Общая обёртка: состояние загрузки, понятная ошибка, гашение тоста. */
    async run(key, action, { silent = false } = {}) {
      this.loading = { ...this.loading, [key]: true }
      this.lastError = ''
      try {
        return await action()
      } catch (error) {
        this.lastError = reason(error)
        if (!silent) this.pushToast(this.lastError, 'error')
        return null
      } finally {
        this.loading = { ...this.loading, [key]: false }
      }
    },

    /* ─────────────────────────── Вход ─────────────────────────── */

    async init() {
      this.ready = false
      const ok = await ensureAccess()
      if (!ok) {
        // Открыто вне Telegram и без сохранённой строки входа — показываем экран связи
        this.offline = true
        this.ready = true
        return false
      }
      this.offline = false
      await Promise.all([this.loadDashboard(), this.loadServices()])
      this.ready = true
      return true
    },

    /** Вход для проверки в браузере (кнопка на экране «нет связи»). */
    async devSignIn(tgId = 1, firstName = 'Игорь') {
      return this.run('dev', async () => {
        const data = await api.get(`/dev/sign-in?tg_id=${tgId}&first_name=${encodeURIComponent(firstName)}`)
        saveAccessToken(data.init_data)
        saveDevUser(data.user)
        this.offline = false
        await this.init()
        return data
      })
    },

    /** Демонстрационные данные: кампании, отчёт по ботам, баланс. */
    async seedDemo() {
      return this.run('seed', async () => {
        const data = await api.post('/dev/seed')
        this.pushToast('Демо-данные загружены', 'success')
        await this.refreshAll()
        return data
      })
    },

    async refreshAll() {
      await Promise.all([this.loadDashboard(), this.loadServices(), this.loadBalance(), this.loadReports()])
    },

    /* ──────────────────────── Главный экран ──────────────────────── */

    async loadDashboard() {
      return this.run('dashboard', async () => {
        const data = await api.get('/dashboard')
        this.dashboard = data
        this.user = data.user
        this.profile = data.profile
        if (data.advice) this.advice = data.advice
        return data
      }, { silent: true })
    },

    /** Совет от модели: отдельный запрос, потому что он ходит в интернет. */
    async loadAdvice() {
      return this.run('advice', async () => {
        const data = await api.get('/dashboard/advice')
        this.advice = data
        if (this.dashboard) this.dashboard.advice = data
        return data
      }, { silent: true })
    },

    async saveProfile(updates) {
      return this.run('profile', async () => {
        const data = await api.post('/onboarding/profile', updates)
        this.profile = data.profile
        return data
      })
    },

    /* ─────────────────────────── Сервисы ─────────────────────────── */

    async loadServices() {
      return this.run('services', async () => {
        const data = await api.get('/services')
        this.services = data
        return data
      }, { silent: true })
    },

    async connectService(kind, payload) {
      return this.run(`connect:${kind}`, async () => {
        const data = await api.post(`/services/${kind}/connect`, payload)
        this.pushToast(data.message || 'Подключено', 'success')
        await this.loadServices()
        return data
      })
    },

    async checkService(kind) {
      return this.run(`check:${kind}`, async () => {
        const data = await api.post(`/services/${kind}/check`)
        this.pushToast(data.message, data.ok ? 'success' : 'error')
        await this.loadServices()
        return data
      })
    },

    async disconnectService(kind) {
      return this.run(`disconnect:${kind}`, async () => {
        const data = await api.del(`/services/${kind}`)
        this.pushToast(data.message || 'Сервис отключён', 'info')
        await this.loadServices()
        return data
      })
    },

    /** Паспорт сайта до сохранения — показывается в окне ввода адреса. */
    async sitePassport(url) {
      return this.run('passport', () => api.get(`/services/site/passport?url=${encodeURIComponent(url)}`))
    },

    /* ─────────────────────────── Кампании ─────────────────────────── */

    async loadCampaigns() {
      return this.run('campaigns', async () => {
        const data = await api.get('/campaigns')
        this.campaigns = data
        return data
      }, { silent: true })
    },

    async syncCampaigns() {
      return this.run('sync', async () => {
        const data = await api.post('/campaigns/sync')
        this.campaigns = {
          campaigns: data.campaigns,
          summary: this.campaigns.summary,
          count: data.campaigns.length,
          needs_sync: false,
        }
        this.pushToast(data.message || 'Данные обновлены', 'success')
        await this.loadCampaigns()
        await this.loadDashboard()
        return data
      })
    },

    async toggleCampaign(id) {
      return this.run(`toggle:${id}`, async () => {
        const data = await api.post(`/campaigns/${id}/toggle`)
        this.pushToast(data.message, 'success')
        await this.loadCampaigns()
        await this.loadDashboard()
        return data
      })
    },

    async updateCampaign(id, payload) {
      return this.run(`update:${id}`, async () => {
        const data = await api.patch(`/campaigns/${id}`, payload)
        this.pushToast(data.message || 'Изменения сохранены', 'success')
        await this.loadCampaigns()
        return data
      })
    },

    async campaignPlan(id) {
      return this.run(`plan:${id}`, () => api.post(`/campaigns/${id}/plan`))
    },

    /* ────────────────────────── Защита от ботов ────────────────────────── */

    async loadBotReport() {
      return this.run('botReport', async () => {
        const data = await api.get('/reports/bots')
        this.botReport = data
        return data
      }, { silent: true })
    },

    async checkBots() {
      return this.run('bots', async () => {
        const data = await api.post('/reports/bots')
        this.botReport = { ...data, has_report: true, report: data.report, summary: data.advice?.text || '' }
        this.pushToast(data.message || 'Проверка завершена', 'success')
        await this.loadDashboard()
        return data
      })
    },

    /* ────────────────────────── Гипотезы ────────────────────────── */

    async loadHypotheses(statusFilter = '') {
      return this.run('hypotheses', async () => {
        const query = statusFilter ? `?status_filter=${statusFilter}` : ''
        const data = await api.get(`/reports/hypotheses${query}`)
        this.hypotheses = data
        return data
      }, { silent: true })
    },

    async buildHypotheses() {
      return this.run('buildHypotheses', async () => {
        const data = await api.post('/reports/hypotheses')
        this.pushToast(data.message || 'Гипотезы собраны', 'success')
        await this.loadHypotheses()
        await this.loadDashboard()
        return data
      })
    },

    async decideHypothesis(id, action, comment = '') {
      return this.run(`decision:${id}`, async () => {
        const data = await api.post(`/reports/hypotheses/${id}`, { action, comment })
        this.pushToast(data.message, action === 'reject' ? 'info' : 'success')
        await this.loadHypotheses()
        await this.loadDashboard()
        return data
      })
    },

    async explainHypothesis(id) {
      return this.run(`explain:${id}`, () => api.get(`/reports/hypotheses/${id}/explain`))
    },

    /* ─────────────────────────── Отчёты ─────────────────────────── */

    async loadReports() {
      return this.run('reports', async () => {
        const data = await api.get('/reports/overview')
        this.reports = data.reports
        return data
      }, { silent: true })
    },

    async runSiteAudit() {
      return this.run('siteAudit', () => api.post('/reports/site'))
    },

    async runGeo() {
      return this.run('geo', () => api.post('/reports/geo'))
    },

    async runMarket() {
      return this.run('market', () => api.post('/reports/market'))
    },

    /* ──────────────────────────── Баланс ──────────────────────────── */

    async loadBalance() {
      return this.run('balance', async () => {
        const [summary, history] = await Promise.all([
          api.get('/payments/balance'),
          api.get('/payments/history'),
        ])
        this.balance = { ...summary, history: history.entries || [] }
        return this.balance
      }, { silent: true })
    },

    async topUp(amount) {
      return this.run('topup', async () => {
        const data = await api.post('/payments/topup', { amount: Number(amount) })
        this.payment = data
        return data
      })
    },

    async paymentStatus(paymentId) {
      return api.get(`/payments/${paymentId}`)
    },

    async confirmPayment(paymentId) {
      return this.run('confirm', async () => {
        const data = await api.post(`/payments/${paymentId}/confirm`)
        this.payment = data
        this.pushToast(data.message || 'Оплата зачтена', 'success')
        await this.loadBalance()
        await this.loadDashboard()
        return data
      })
    },

    clearPayment() {
      this.payment = null
    },

    /* ───────────────────────── Онбординг ───────────────────────── */

    async loadOnboarding() {
      return this.run('onboarding', async () => {
        const data = await api.get('/onboarding')
        this.onboarding = data
        this.profile = data.profile
        return data
      }, { silent: true })
    },

    async completeOnboarding() {
      return this.run('complete', async () => {
        const data = await api.post('/onboarding/complete')
        if (this.dashboard?.user) this.dashboard.user.onboarding_completed = true
        if (this.user) this.user.onboarding_completed = true
        return data
      }, { silent: true })
    },
  },
})

export { hasAccess }
