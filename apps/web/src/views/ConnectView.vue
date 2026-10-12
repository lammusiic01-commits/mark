<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { ConnectedAccount, LoginSession, ServiceDef, ValidationCheck, ValidationResult } from '@mark/shared';
import { api } from '@/api/client';
import { subscribeChannels } from '@/api/realtime';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';

/**
 * Пошаговое подключение сервиса.
 *
 * Сценарий:
 *  1) выбрать сервис (поиск по названию/категории);
 *  2) выбрать способ авторизации — «Войти в окне приложения», OAuth или API-токен;
 *  3) проверить подключение: шаги проверки приходят в реальном времени по WebSocket;
 *  4) сохранить — MARK шифрует секреты и сразу использует подключение в остальных модулях.
 */

const store = useAppStore();

const step = ref<1 | 2 | 3>(1);
const search = ref('');
const selectedService = ref<ServiceDef | null>(null);
const authMode = ref<string>('');
const fields = reactive<Record<string, string>>({});
const sandbox = ref(false);
const label = ref('');
const validating = ref(false);
const checks = ref<ValidationCheck[]>([]);
const result = ref<ValidationResult | null>(null);
const validationChannel = ref<string | null>(null);
const accounts = ref<(ConnectedAccount & { service?: string })[]>([]);
const sessions = ref<LoginSession[]>([]);
const busy = ref(false);
const showSessionModal = ref(false);
const sessionService = ref<ServiceDef | null>(null);
const manualCookies = ref('');
const loginMode = ref<'electron' | 'playwright' | 'manual'>('electron');
const desktop = typeof window !== 'undefined' ? window.mark : undefined;

const serviceDetail = ref<{ authHelp?: Record<string, string[]>; browserLoginUrl?: string | null } | null>(null);

onMounted(async () => {
  await Promise.all([loadAccounts(), loadSessions()]);
});

watch(selectedService, async (service) => {
  if (!service) return;
  authMode.value = service.authModes[0]?.id ?? '';
  for (const key of Object.keys(fields)) delete fields[key];
  result.value = null;
  checks.value = [];
  serviceDetail.value = await store.call(() => api.get(`/api/services/${service.id}`), 'Не удалось получить описание сервиса');
});

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  const services = store.services;
  if (!query) return services;
  return services.filter((service) =>
    `${service.name} ${service.vendor} ${service.category} ${service.capabilities.join(' ')} ${(service.notes ?? []).join(' ')}`.toLowerCase().includes(query),
  );
});

const modeDef = computed(() => selectedService.value?.authModes.find((mode) => mode.id === authMode.value) ?? null);
const needsLogin = computed(() => modeDef.value?.needsInAppLogin === true);
const stepsCount = computed(() => (needsLogin.value || authMode.value === 'oauth' ? 3 : 3));

async function loadAccounts(): Promise<void> {
  const items = await store.call(() => api.get<(ConnectedAccount & { service?: string })[]>('/api/accounts'), 'Не удалось загрузить подключения');
  if (items) accounts.value = items;
}

async function loadSessions(): Promise<void> {
  const items = await store.call(() => api.get<LoginSession[]>('/api/sessions'), 'Не удалось загрузить окна входа');
  if (items) sessions.value = items;
}

function chooseService(service: ServiceDef): void {
  selectedService.value = service;
  step.value = 2;
}

/* --------------------------- Проверка подключения --------------------------- */

async function validate(): Promise<void> {
  if (!selectedService.value || !authMode.value) return;
  validating.value = true;
  checks.value = [];
  result.value = null;

  const started = await store.call(
    () =>
      api.post<{ validationId: string; channel: string }>('/api/validate', {
        serviceId: selectedService.value!.id,
        authMode: authMode.value,
        fields: { ...fields },
        sandbox: sandbox.value,
        label: label.value || undefined,
        clientId: store.activeClientId || null,
      }),
    'Не удалось запустить проверку',
  );

  if (!started) {
    validating.value = false;
    return;
  }

  validationChannel.value = started.channel;
  const stop = subscribeChannels([started.channel], (event) => {
    if (event.type === 'check') {
      const check = event.payload as ValidationCheck;
      const index = checks.value.findIndex((item) => item.key === check.key);
      if (index >= 0) checks.value.splice(index, 1, check);
      else checks.value.push(check);
    }
  });

  // Опрашиваем итог, событие «done» может прийти раньше, чем закроется соединение
  const poll = window.setInterval(async () => {
    const payload = await store.call(() => api.get<ValidationResult | { pending: true }>(`/api/validate/${started.validationId}`), '');
    if (payload && !('pending' in payload)) {
      result.value = payload as ValidationResult;
      validating.value = false;
      window.clearInterval(poll);
      stop();
      await loadAccounts();
      if (result.value.status === 'pass') store.toast('success', 'Подключение работает', `${selectedService.value?.name}: проверка пройдена.`);
      else if (result.value.status === 'warn') store.toast('warning', 'Подключение с замечаниями', 'Работать можно, но часть возможностей ограничена.');
      else store.toast('error', 'Подключение не работает', 'Смотрите детали проверки.');
    }
  }, 900);
}

/* ------------------------------ Окно входа ------------------------------ */

function openSessionModal(service: ServiceDef): void {
  sessionService.value = service;
  showSessionModal.value = true;
  manualCookies.value = '';
}

async function startSession(mode: 'electron' | 'playwright' | 'manual'): Promise<void> {
  if (!sessionService.value) return;
  busy.value = true;
  loginMode.value = mode;
  try {
    const session = await store.call(
      () =>
        api.post<LoginSession & { channel: string }>('/api/sessions', {
          serviceId: sessionService.value!.id,
          mode,
          clientId: store.activeClientId || null,
        }),
      'Не удалось открыть окно входа',
    );
    if (!session) return;
    sessions.value = [session, ...sessions.value];
    if (mode === 'manual') {
      store.toast('info', 'Окно входа создано', 'Вставьте cookies из браузера в поле ниже и нажмите «Сохранить cookies».');
      return;
    }
    if (mode === 'playwright') {
      store.toast('info', 'Окно браузера открыто на сервере', 'Войдите в аккаунт — MARK сам заберёт cookies после входа.');
    } else if (desktop?.login) {
      // Приложение MARK Desktop: открываем окно входа внутри приложения и забираем cookies
      try {
        const result = await desktop.login.open({
          sessionId: session.id,
          url: session.url,
          serviceId: sessionService.value!.id,
          serviceName: sessionService.value!.name,
        });
        store.toast(
          'info',
          result?.ok === false ? 'Окно входа не открылось' : 'Окно входа открыто',
          'Войдите в аккаунт в отдельном окне приложения — затем нажмите «Забрать cookies» в панели MARK Desktop.',
          9000,
        );
      } catch (error) {
        store.notifyError(error, 'Не удалось открыть окно входа в приложении');
      }
    } else {
      store.toast(
        'info',
        'Окно входа готово',
        'Откройте MARK Desktop (npm run desktop:start) — окно входа появится внутри приложения, cookies вернутся в MARK. Можно также использовать Playwright или ручной импорт ниже.',
        9000,
      );
    }

    const stop = subscribeChannels([session.channel], (event) => {
      if (event.type === 'captured') {
        store.toast('success', 'Сессия сохранена', `Cookies сервиса получены (${(event.payload as { cookiesCount?: number })?.cookiesCount ?? 0} шт.).`);
        void loadSessions();
        stop();
      }
      if (event.type === 'failed') {
        store.toast('error', 'Вход не удался', String((event.payload as { error?: string })?.error ?? ''));
        stop();
      }
    });
  } finally {
    busy.value = false;
  }
}

async function grabCookies(): Promise<void> {
  if (!desktop?.login) return;
  busy.value = true;
  const result = await desktop.login.save();
  busy.value = false;
  if (result.ok) {
    store.toast('success', 'Сессия сохранена', `Cookies сервиса получены: ${result.cookies}. MARK уже управляет сервисом от вашего имени.`);
    showSessionModal.value = false;
    await Promise.all([loadSessions(), loadAccounts()]);
  } else {
    store.toast('warning', 'Cookies не найдены', result.error ?? 'Войдите в аккаунт в окне сервиса и попробуйте снова.');
  }
}

async function focusLoginWindow(): Promise<void> {
  await desktop?.login.focus();
}

async function submitCookies(): Promise<void> {
  const session = sessions.value[0];
  if (!session) {
    store.toast('warning', 'Сначала создайте окно входа');
    return;
  }
  if (!manualCookies.value.trim()) {
    store.toast('warning', 'Вставьте строку cookies');
    return;
  }
  busy.value = true;
  const saved = await store.call(
    () => api.post(`/api/sessions/${session.id}/cookies`, { cookieHeader: manualCookies.value.trim() }),
    'Не удалось сохранить cookies',
  );
  busy.value = false;
  if (saved) {
    store.toast('success', 'Cookies сохранены', 'Сессия привязана к подключению — им можно пользоваться.');
    await Promise.all([loadSessions(), loadAccounts()]);
  }
}

async function closeSession(id: string): Promise<void> {
  await store.call(() => api.post(`/api/sessions/${id}/close`), 'Не удалось закрыть сессию');
  await loadSessions();
}

/* ------------------------------ Аккаунты ------------------------------ */

async function revalidate(account: ConnectedAccount): Promise<void> {
  busy.value = true;
  const response = await store.call(
    () => api.post<{ result: ValidationResult; account: ConnectedAccount }>(`/api/accounts/${account.id}/validate`),
    'Проверка не удалась',
  );
  busy.value = false;
  if (response) {
    const ok = response.result.status !== 'fail';
    store.toast(ok ? 'success' : 'error', ok ? 'Подключение работает' : 'Подключение не работает', response.result.checks.find((check) => check.status === 'fail')?.message);
    await loadAccounts();
  }
}

async function removeAccount(account: ConnectedAccount): Promise<void> {
  if (!window.confirm(`Удалить подключение «${account.label}»? Секреты будут стёрты.`)) return;
  await store.call(() => api.delete(`/api/accounts/${account.id}`), 'Не удалось удалить подключение');
  await loadAccounts();
}

async function startOauth(serviceId: string): Promise<void> {
  const started = await store.call(
    () => api.post<{ authorizeUrl?: string; implicit?: boolean; state?: string; redirectUri?: string }>(`/api/oauth/${serviceId}/start`, {}),
    'OAuth не настроен для этого сервиса',
  );
  if (!started?.authorizeUrl) {
    store.toast('warning', 'OAuth недоступен', 'У сервиса нет OAuth-приложения в MARK — используйте вход в окне приложения или API-токен.');
    return;
  }
  window.open(started.authorizeUrl, '_blank', 'width=560,height=720');
  store.toast('info', 'Открыто окно авторизации', 'После подтверждения доступа вернитесь в MARK — подключение появится в списке.');
}

function resetWizard(): void {
  step.value = 1;
  selectedService.value = null;
  authMode.value = '';
  checks.value = [];
  result.value = null;
  for (const key of Object.keys(fields)) delete fields[key];
}
</script>

<template>
  <div class="split">
    <!-- Шаги подключения -->
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Новое подключение</h3>
          <div class="sub">Шаг {{ step }} из {{ stepsCount }}</div>
        </div>
        <button v-if="step > 1" class="btn ghost sm" @click="resetWizard"><Icon name="refresh" /> Заново</button>
      </div>

      <div class="bar" style="margin-bottom: 14px"><span :style="{ width: `${(step / stepsCount) * 100}%` }" /></div>

      <!-- Шаг 1: выбор сервиса -->
      <template v-if="step === 1">
        <div class="field">
          <label>Поиск сервиса</label>
          <input v-model="search" type="text" placeholder="Например: Яндекс.Директ, Метрика, Tilda, GitHub…" />
        </div>
        <div style="max-height: 420px; overflow: auto">
          <button
            v-for="service in filtered"
            :key="service.id"
            class="btn ghost block"
            style="justify-content: flex-start; margin-bottom: 6px; text-align: left"
            @click="chooseService(service)"
          >
            <div style="flex: 1">
              <div><strong>{{ service.name }}</strong> <span class="faint small">{{ service.vendor }}</span></div>
              <div class="small muted">{{ service.notes?.[0] ?? service.docsUrl }}</div>
            </div>
            <Icon name="external" />
          </button>
          <div v-if="!filtered.length" class="small muted">Ничего не найдено — попробуйте другой запрос.</div>
        </div>
      </template>

      <!-- Шаг 2: способ авторизации -->
      <template v-else-if="step === 2 && selectedService">
        <div class="row between" style="margin-bottom: 10px">
          <div>
            <strong>{{ selectedService.name }}</strong>
            <div class="small muted">{{ selectedService.vendor }} · {{ modeDef?.description ?? selectedService.docsUrl }}</div>
          </div>
          <StatusPill v-if="selectedService.supportsSandbox" status="info" label="есть песочница" />
        </div>

        <div class="field">
          <label>Способ авторизации</label>
          <select v-model="authMode">
            <option v-for="mode in selectedService.authModes" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
          </select>
          <div v-if="modeDef" class="hint">{{ modeDef.description }}</div>
          <div v-if="serviceDetail?.authHelp?.[authMode]" class="hint">
            <div v-for="hint in serviceDetail.authHelp[authMode]" :key="hint">• {{ hint }}</div>
          </div>
        </div>

        <div v-if="needsLogin" class="card tight" style="margin-bottom: 12px">
          <div class="row between">
            <div>
              <strong>Вход в окне приложения</strong>
              <div class="small muted">MARK откроет страницу входа сервиса и сам заберёт cookies — это заменяет ручное копирование токенов.</div>
            </div>
            <button class="btn primary sm" @click="openSessionModal(selectedService)"><Icon name="key" /> Открыть вход</button>
          </div>
        </div>

        <div v-if="authMode === 'oauth'" class="card tight" style="margin-bottom: 12px">
          <div class="row between">
            <div class="small muted">OAuth-подключение: откроется страница согласия сервиса, токены вернутся в MARK автоматически.</div>
            <button class="btn sm" @click="startOauth(selectedService.id)"><Icon name="external" /> Войти через OAuth</button>
          </div>
        </div>

        <div class="field">
          <label>Название подключения</label>
          <input v-model="label" type="text" :placeholder="`Например: ${selectedService.name} — клиент ${store.activeClient?.name ?? 'агентство'}`" />
        </div>

        <div v-for="field in modeDef?.fields ?? []" :key="field.key" class="field">
          <label>{{ field.label }} <span v-if="field.required" class="faint">*</span></label>
          <input
            v-model="fields[field.key]"
            :type="field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'"
            :placeholder="field.placeholder ?? ''"
          />
          <div v-if="field.help" class="hint">{{ field.help }}</div>
        </div>

        <label v-if="selectedService.supportsSandbox" class="checkbox" style="margin-bottom: 10px">
          <input v-model="sandbox" type="checkbox" /> Проверять в песочнице (без реальных запросов)
        </label>

        <div class="row">
          <button class="btn primary" :disabled="validating" @click="validate">
            <span v-if="validating" class="spinner" /><Icon v-else name="check" /> Проверить и сохранить
          </button>
          <button class="btn ghost" @click="step = 1">Назад</button>
        </div>
      </template>

      <!-- Шаг 3: результат проверки -->
      <template v-else>
        <div class="row between" style="margin-bottom: 8px">
          <div>
            <strong>{{ selectedService?.name }}</strong>
            <div class="small muted">{{ result ? `Проверка завершена: ${result.status === 'pass' ? 'успешно' : result.status === 'warn' ? 'с замечаниями' : 'ошибка'}` : 'Выполняется проверка…' }}</div>
          </div>
          <StatusPill :status="result?.status ?? (validating ? 'validating' : 'unchecked')" />
        </div>

        <div class="steps" style="margin-bottom: 12px">
          <div v-for="check in checks" :key="check.key" class="step" :class="check.status">
            <span class="dot" />
            <div>
              <strong>{{ check.title }}</strong>
              <div class="small muted">{{ check.message }}</div>
              <div v-if="check.details" class="small faint mono">{{ JSON.stringify(check.details).slice(0, 220) }}</div>
            </div>
          </div>
          <div v-if="!checks.length" class="small muted">Шаги проверки появятся здесь по мере выполнения.</div>
        </div>

        <div v-if="result?.accountInfo" class="card tight" style="margin-bottom: 10px">
          <strong class="small">Данные аккаунта</strong>
          <div class="small mono faint" style="word-break: break-all">{{ JSON.stringify(result.accountInfo, null, 2) }}</div>
        </div>

        <div class="row">
          <button class="btn primary" @click="resetWizard"><Icon name="plus" /> Подключить ещё сервис</button>
          <button class="btn" :disabled="validating" @click="validate"><Icon name="refresh" /> Повторить проверку</button>
        </div>
      </template>
    </div>

    <!-- Список подключений -->
    <div class="grid" style="gap: 16px">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Подключённые сервисы</h3>
            <div class="sub">Секреты хранятся в зашифрованном виде (AES-256-GCM), ключ — в .data/vault.key</div>
          </div>
          <button class="btn sm" @click="loadAccounts"><Icon name="refresh" /> Обновить</button>
        </div>

        <table v-if="accounts.length">
          <thead>
            <tr>
              <th>Название</th>
              <th>Сервис</th>
              <th>Способ</th>
              <th>Статус</th>
              <th>Проверено</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in accounts" :key="account.id">
              <td>
                <strong>{{ account.label }}</strong>
                <div v-if="account.lastError" class="small" style="color: #fca5a5">{{ account.lastError }}</div>
              </td>
              <td>{{ account.service }}</td>
              <td class="small mono">{{ account.authMode }}</td>
              <td><StatusPill :status="account.status" /></td>
              <td class="small muted">{{ account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString('ru-RU') : '—' }}</td>
              <td class="num">
                <div class="row" style="justify-content: flex-end">
                  <button class="btn ghost sm" :disabled="busy" @click="revalidate(account)"><Icon name="refresh" /></button>
                  <button class="btn ghost sm" @click="removeAccount(account)"><Icon name="trash" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="Подключений пока нет" message="Выберите сервис слева — MARK проверит доступ и сохранит секреты." icon="plug" />
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Окна входа</h3>
            <div class="sub">Сессии входа в сервисы: Electron, серверный браузер или ручной импорт cookies</div>
          </div>
          <button class="btn sm" @click="loadSessions"><Icon name="refresh" /> Обновить</button>
        </div>

        <table v-if="sessions.length">
          <thead>
            <tr>
              <th>Сервис</th>
              <th>Режим</th>
              <th>Статус</th>
              <th class="num">Cookies</th>
              <th>Обновлено</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions" :key="session.id">
              <td class="mono small">{{ session.serviceId }}</td>
              <td class="small">{{ session.mode }}</td>
              <td><StatusPill :status="session.status" :label="session.message" /></td>
              <td class="num">{{ session.cookiesCount }}</td>
              <td class="small muted">{{ new Date(session.updatedAt).toLocaleString('ru-RU') }}</td>
              <td class="num">
                <button v-if="session.status !== 'closed'" class="btn ghost sm" @click="closeSession(session.id)"><Icon name="close" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="Окон входа не было" message="Для сервисов без API (Tilda, Вебмастер и др.) используйте «Войти в окне приложения»." icon="key" />
      </div>
    </div>
  </div>

  <!-- Модальное окно входа -->
  <Modal
    v-if="showSessionModal && sessionService"
    size="md"
    :title="`Вход в ${sessionService.name}`"
    subtitle="MARK откроет страницу авторизации и сохранит сессию — дальше сервисом можно управлять из приложения."
    @close="showSessionModal = false"
  >
    <div class="grid" style="gap: 10px">
      <div class="card tight">
        <div class="row between">
          <div>
            <strong>1. Окно в приложении (рекомендуется)</strong>
            <div class="small muted">Откройте MARK Desktop — окно входа появится поверх, cookies вернутся в MARK сами.</div>
          </div>
          <button class="btn primary sm" :disabled="busy" @click="startSession('electron')"><Icon name="user" /> Открыть</button>
        </div>
        <div v-if="desktop?.isDesktop" class="row" style="margin-top: 8px">
          <button class="btn sm" @click="grabCookies"><Icon name="download" /> Забрать cookies из окна приложения</button>
          <button class="btn ghost sm" @click="focusLoginWindow"><Icon name="eye" /> Показать окно</button>
        </div>
      </div>

      <div class="card tight">
        <div class="row between">
          <div>
            <strong>2. Браузер на сервере (Playwright)</strong>
            <div class="small muted">Сервер сам откроет видимое окно браузера и заберёт cookies после входа. Требуется графическое окружение.</div>
          </div>
          <button class="btn sm" :disabled="busy" @click="startSession('playwright')"><Icon name="eye" /> Открыть</button>
        </div>
      </div>

      <div class="card tight">
        <div>
          <strong>3. Ручной импорт cookies</strong>
          <div class="small muted" style="margin-bottom: 8px">
            Войдите в сервис в своём браузере → DevTools → Network → любой запрос → Request Headers → скопируйте Cookie целиком.
          </div>
          <textarea v-model="manualCookies" rows="4" placeholder="sessionid=…; csrftoken=…; …" />
          <div class="row" style="margin-top: 8px">
            <button class="btn sm" :disabled="busy" @click="startSession('manual')">Создать сессию</button>
            <button class="btn primary sm" :disabled="busy || !sessions.length" @click="submitCookies">Сохранить cookies</button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost" @click="showSessionModal = false">Готово</button>
    </template>
  </Modal>
</template>
