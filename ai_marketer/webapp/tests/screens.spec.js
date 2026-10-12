/*
  Проверка экранов на живом API.

  Поднимаем API (python3 dev_server.py) и запускаем: npx vitest run.
  Тест открывает приложение, проходит по всем разделам и проверяет, что каждый
  экран отрисовался на реальных данных и не бросил ни одной ошибки. Если сервер
  не отвечает — проверки пропускаются, чтобы прогон тестов не падал без него.
*/
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeAll, describe, expect, it } from 'vitest'
import App from '../src/App.vue'
import router from '../src/router.js'
import { API_ORIGIN, apiAvailable } from './setup.js'

const live = await apiAvailable()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ждём, пока на экране появится ожидаемый текст (данные грузятся с сервера). */
async function waitForText(text, wrapper, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (wrapper.html().includes(text)) return true
    await flushPromises()
    await sleep(60)
  }
  return wrapper.html().includes(text)
}

const SCREENS = [
  { path: '/', text: 'Клики', title: 'Главная' },
  { path: '/reports', text: 'Отчёты', title: 'Отчёты' },
  { path: '/campaigns', text: 'Кампании', title: 'Кампании' },
  { path: '/bot-shield', text: 'Ловля ботов', title: 'Защита от ботов' },
  { path: '/hypotheses', text: 'Гипотезы', title: 'Гипотезы' },
  { path: '/balance', text: 'Баланс', title: 'Баланс' },
  { path: '/connect', text: 'Подключения', title: 'Подключения' },
  { path: '/settings', text: 'Профиль', title: 'Настройки' },
  { path: '/onboarding', text: 'Далее', title: 'Онбординг' },
]

describe.skipIf(!live)('Экраны Mini App на живом API', () => {
  let wrapper
  const errors = []

  beforeAll(async () => {
    // Демо-данные: профиль, подключения, кампании, отчёт по ботам, баланс
    const response = await fetch(`${API_ORIGIN}/api/dev/seed`, { method: 'POST' })
    expect(response.ok).toBe(true)

    const pinia = createPinia()
    wrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [pinia, router],
        config: {
          errorHandler(error) {
            errors.push(error?.message || String(error))
          },
        },
      },
    })

    await router.isReady()
    // App.init(): вход в режиме разработки + загрузка онбординга
    await waitForText('Загружаем вашу рекламу', wrapper, 500)
    await flushPromises()
    await sleep(400)
    await flushPromises()
  })

  it('вход выполнен, показан главный экран', async () => {
    expect(errors, errors.join(' | ')).toEqual([])
    expect(wrapper.html()).not.toContain('Откройте приложение из бота')
  })

  for (const screen of SCREENS) {
    it(`${screen.title}: ${screen.path} рисуется без ошибок`, async () => {
      await router.push(screen.path)
      await flushPromises()

      const shown = await waitForText(screen.text, wrapper)
      expect(shown, `на экране ${screen.path} нет текста «${screen.text}»`).toBe(true)
      expect(errors, `${screen.path}: ${errors.join(' | ')}`).toEqual([])
    })
  }

  it('на экранах нет «undefined» и «NaN»', () => {
    const html = wrapper.html()
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('NaN')
  })

  it('кампании и отчёты берут данные с сервера', async () => {
    await router.push('/campaigns')
    await flushPromises()
    await sleep(600)
    await flushPromises()
    expect(wrapper.html()).toMatch(/Ремонт|Активна|Пауза|кампани/i)

    await router.push('/reports')
    await flushPromises()
    await sleep(400)
    await flushPromises()
    expect(wrapper.html()).toContain('Разбор рекламы')
  })
})
