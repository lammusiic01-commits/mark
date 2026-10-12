/*
  Сценарии пользователя на живом API.

  Проверяем не отдельные экраны, а действия: подключение сервисов, синхронизацию
  кампаний и правку ставок, поиск гипотез, отчёт по ботам, пополнение баланса,
  анкету бизнеса и онбординг. Тест идёт через то же хранилище, которым
  пользуются экраны, — значит, проверяется настоящий контракт между Mini App
  и сервером. Если сервер не поднят, проверки пропускаются.
*/
import { createPinia, setActivePinia } from 'pinia'
import { beforeAll, describe, expect, it } from 'vitest'
import { API_ORIGIN, apiAvailable } from './setup.js'

const live = await apiAvailable()

describe.skipIf(!live)('Сценарии Mini App на живом API', () => {
  let store

  beforeAll(async () => {
    // Демо-данные: так сценарии проверяются на предсказуемом наборе
    const seeded = await fetch(`${API_ORIGIN}/api/dev/seed`, { method: 'POST' })
    expect(seeded.ok).toBe(true)

    setActivePinia(createPinia())
    const { useAppStore } = await import('../src/store/index.js')
    store = useAppStore()
    await store.init()
    expect(store.offline).toBe(false)
  })

  it('вход и анкета бизнеса: ниша, регион, бюджет, цель по заявке', async () => {
    const data = await store.saveProfile({
      niche: 'стройка-ремонт',
      region_code: 213,
      site_url: 'remont-demo.ru',
      monthly_budget_rub: 150000,
      target_cpa_rub: 2500,
    })
    expect(data, store.lastError).toBeTruthy()
    expect(data.profile.niche).toBe('стройка-ремонт')
    expect(data.profile.target_cpa_rub).toBe(2500)
    expect(store.profile.site_url).toContain('remont-demo.ru')
  })

  it('онбординг: шаги, ниши и регионы приходят с сервера', async () => {
    await store.loadOnboarding()
    expect(store.onboarding.steps.length).toBeGreaterThanOrEqual(5)
    expect(store.onboarding.niches.length).toBeGreaterThan(3)
    expect(store.onboarding.regions.some((region) => region.code === 213)).toBe(true)

    const done = await store.completeOnboarding()
    expect(done, store.lastError).toBeTruthy()
    expect(done.completed).toBe(true)
    expect(done.next).toBe('/dashboard')
  })

  it('подключения: три сервиса, паспорт сайта, отключение и возврат', async () => {
    const services = await store.loadServices()
    expect(services.connected_count).toBe(3)
    expect(services.ready).toBe(true)

    // Паспорт сайта: платформа, скорость, счётчик Метрики
    const passport = await store.sitePassport('remont-demo.ru')
    expect(passport, store.lastError).toBeTruthy()
    expect(passport.url).toContain('remont-demo.ru')

    // Отключаем Метрику и убеждаемся, что сервис пропал из активных
    await store.disconnectService('yandex_metrika')
    expect(store.services.connected_count).toBe(2)
    expect(store.services.services.find((item) => item.kind === 'yandex_metrika').connected).toBe(false)

    // Возвращаем демо-подключение, чтобы следующие проверки шли на полном наборе
    await fetch(`${API_ORIGIN}/api/dev/seed`, { method: 'POST' })
    await store.loadServices()
    expect(store.services.connected_count).toBe(3)
  })

  it('кампании: список, синхронизация, пауза и правка цели по заявке', async () => {
    const list = await store.loadCampaigns()
    expect(list.count).toBe(3)
    expect(list.active_count).toBeGreaterThanOrEqual(2)
    expect(list.summary.total_cost_rub).toBeGreaterThan(0)

    const synced = await store.syncCampaigns()
    expect(synced, store.lastError).toBeTruthy()
    expect(synced.campaigns.length).toBe(3)

    const active = store.campaigns.campaigns.find((item) => item.status === 'active')
    const paused = await store.toggleCampaign(active.id)
    expect(paused, store.lastError).toBeTruthy()
    expect(paused.campaign.status).toBe('paused')
    expect(store.campaigns.campaigns.find((item) => item.id === active.id).status).toBe('paused')

    // Возвращаем кампанию в работу и меняем бюджет с целью по заявке
    const resumed = await store.toggleCampaign(active.id)
    expect(resumed.campaign.status).toBe('active')

    const updated = await store.updateCampaign(active.id, { target_cpa_rub: 2200, daily_budget_rub: 1500 })
    expect(updated, store.lastError).toBeTruthy()
    const campaign = store.campaigns.campaigns.find((item) => item.id === active.id)
    expect(campaign.target_cpa).toBe(2200)
    expect(campaign.daily_budget).toBe(1500)

    // План по кампании: распределение бюджета, ставки и пояснение
    const plan = await store.campaignPlan(active.id)
    expect(plan, store.lastError).toBeTruthy()
    expect(plan.allocation).toBeTruthy()
    expect(plan.bid_plan).toBeTruthy()
  })

  it('главная: метрики, баланс и совет собираются из данных Директа', async () => {
    const dashboard = await store.loadDashboard()
    expect(dashboard, store.lastError).toBeTruthy()
    expect(dashboard.metrics.length).toBe(4)
    expect(dashboard.totals.clicks).toBeGreaterThan(2000)
    expect(dashboard.money.balance_text).toContain('₽')
    expect(dashboard.advice.text.length).toBeGreaterThan(40)
    expect(dashboard.direct.details.campaigns).toBe(3)
  })

  it('совет от модели: текст приходит или подставляется расчётный', async () => {
    const advice = await store.loadAdvice()
    expect(advice, store.lastError).toBeTruthy()
    expect(advice.source === 'ai' || advice.source === 'template').toBe(true)
    expect(advice.text.length).toBeGreaterThan(40)
  })

  it('ловля ботов: отчёт, история и разбор экономии', async () => {
    const report = await store.loadBotReport()
    expect(report, store.lastError).toBeTruthy()
    expect(report.has_report).toBe(true)
    expect(report.report.risk_score).toBeGreaterThan(0)
    expect(report.report.patterns.length).toBeGreaterThan(0)
    expect(report.report.monthly_savings_rub).toBeGreaterThan(0)

    const fresh = await store.checkBots()
    expect(fresh, store.lastError).toBeTruthy()
    expect(fresh.report.wasted_rub).toBeGreaterThan(0)
  })

  it('гипотезы: сбор, объяснение и решение по каждой', async () => {
    const built = await store.buildHypotheses()
    expect(built, store.lastError).toBeTruthy()
    expect(store.hypotheses.hypotheses.length).toBeGreaterThan(0)

    const pending = store.hypotheses.hypotheses.filter((item) => item.status === 'pending')
    expect(pending.length).toBeGreaterThan(0)

    const explained = await store.explainHypothesis(pending[0].id)
    expect(explained, store.lastError).toBeTruthy()
    expect(explained.advice.text.length).toBeGreaterThan(20)

    const applied = await store.decideHypothesis(pending[0].id, 'apply')
    expect(applied, store.lastError).toBeTruthy()
    expect(['applied', 'pending', 'rejected']).toContain(applied.hypothesis.status)

    if (pending[1]) {
      const rejected = await store.decideHypothesis(pending[1].id, 'reject')
      expect(rejected.hypothesis.status).toBe('rejected')
    }
  })

  it('отчёты: список разделов и рыночный разбор', async () => {
    await store.loadReports()
    expect(store.reports.length).toBeGreaterThanOrEqual(4)
    expect(store.reports.map((item) => item.key)).toContain('bots')

    const market = await store.runMarket()
    expect(market, store.lastError).toBeTruthy()
    expect(market.analysis.market_cpc_rub).toBeGreaterThan(0)
    expect(market.analysis.summary_text.length).toBeGreaterThan(20)

    const geo = await store.runGeo()
    expect(geo, store.lastError).toBeTruthy()
    expect(geo.analysis.advices.length).toBeGreaterThan(0)
  })

  it('баланс: пополнение, статус платежа и зачисление', async () => {
    const before = await store.loadBalance()
    expect(before.balance_text).toContain('₽')

    const payment = await store.topUp(3000)
    expect(payment, store.lastError).toBeTruthy()
    expect(payment.amount).toBe(3000)
    expect(payment.status).toBe('pending')
    expect(payment.qr_png_base64, 'нет QR-кода для оплаты').toBeTruthy()

    const status = await store.paymentStatus(payment.payment_id)
    expect(status.status).toBeTruthy()
    expect(status.payment_id).toBe(payment.payment_id)

    const confirmed = await store.confirmPayment(payment.payment_id)
    expect(confirmed, store.lastError).toBeTruthy()
    expect(confirmed.status).toBe('paid')
    expect(store.balance.balance).toBeGreaterThan(before.balance)
  })

  it('ни один запрос не оставил непонятную ошибку', () => {
    expect(store.lastError).toBe('')
  })
})
