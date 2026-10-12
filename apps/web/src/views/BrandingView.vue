<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';

/**
 * Белая метка: агентство подставляет своё имя, цвета, логотип и подписи.
 * Эти же данные попадают в HTML/PDF-отчёты (клиент не видит бренд MARK).
 */

const store = useAppStore();
const busy = ref(false);
const saved = ref(false);

const form = reactive({
  agencyName: 'MARK Demo Agency',
  slug: 'agency',
  brandColor: '#2563eb',
  accentColor: '#0ea5e9',
  supportEmail: '',
  supportPhone: '',
  footerNote: '',
  reportFooter: '',
  hideMarkBranding: false,
  locale: 'ru' as 'ru' | 'en',
  logoDataUrl: null as string | null,
});

onMounted(() => {
  const branding = store.branding;
  if (!branding) return;
  Object.assign(form, {
    agencyName: branding.agencyName,
    slug: branding.slug,
    brandColor: branding.brandColor,
    accentColor: branding.accentColor,
    supportEmail: branding.supportEmail ?? '',
    supportPhone: branding.supportPhone ?? '',
    footerNote: branding.footerNote ?? '',
    reportFooter: branding.reportFooter ?? '',
    hideMarkBranding: branding.hideMarkBranding,
    locale: branding.locale,
    logoDataUrl: branding.logoDataUrl ?? null,
  });
});

function pickLogo(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 400_000) {
    store.toast('warning', 'Файл слишком большой', 'Логотип должен быть меньше 400 КБ — он встраивается в HTML-отчёты.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    form.logoDataUrl = String(reader.result);
    store.toast('info', 'Логотип загружен', 'Не забудьте сохранить изменения.');
  };
  reader.readAsDataURL(file);
}

async function save(): Promise<void> {
  busy.value = true;
  await store.call(
    () =>
      store.saveBranding({
        agencyName: form.agencyName,
        slug: form.slug,
        brandColor: form.brandColor,
        accentColor: form.accentColor,
        supportEmail: form.supportEmail || null,
        supportPhone: form.supportPhone || null,
        footerNote: form.footerNote || null,
        reportFooter: form.reportFooter || null,
        hideMarkBranding: form.hideMarkBranding,
        locale: form.locale,
        logoDataUrl: form.logoDataUrl,
      }),
    'Не удалось сохранить оформление',
  );
  busy.value = false;
  saved.value = true;
  window.setTimeout(() => (saved.value = false), 2500);
}
</script>

<template>
  <div class="split">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Оформление агентства</h3>
          <div class="sub">Используется в интерфейсе и во всех отчётах клиентам</div>
        </div>
      </div>

      <div class="field">
        <label>Название агентства</label>
        <input v-model="form.agencyName" type="text" />
      </div>

      <div class="field">
        <label>Короткий идентификатор (slug)</label>
        <input v-model="form.slug" type="text" placeholder="agency" />
      </div>

      <div class="grid cols-2">
        <div class="field">
          <label>Основной цвет</label>
          <div class="row">
            <input v-model="form.brandColor" type="color" style="width: 46px; height: 38px; padding: 2px" />
            <input v-model="form.brandColor" type="text" class="mono" />
          </div>
        </div>
        <div class="field">
          <label>Акцентный цвет</label>
          <div class="row">
            <input v-model="form.accentColor" type="color" style="width: 46px; height: 38px; padding: 2px" />
            <input v-model="form.accentColor" type="text" class="mono" />
          </div>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="field">
          <label>E-mail поддержки</label>
          <input v-model="form.supportEmail" type="email" placeholder="hello@agency.ru" />
        </div>
        <div class="field">
          <label>Телефон</label>
          <input v-model="form.supportPhone" type="text" placeholder="+7 (495) 000-00-00" />
        </div>
      </div>

      <div class="field">
        <label>Подпись в отчёте</label>
        <input v-model="form.footerNote" type="text" placeholder="Отчёт подготовлен агентством …" />
      </div>

      <div class="field">
        <label>Дисклеймер (мелкий текст внизу отчёта)</label>
        <textarea v-model="form.reportFooter" rows="2" placeholder="Конфиденциально. Данные не подлежат передаче третьим лицам." />
      </div>

      <div class="field">
        <label>Логотип</label>
        <div class="row">
          <label class="btn sm"><Icon name="upload" /> Загрузить PNG/SVG<input type="file" accept="image/png,image/svg+xml,image/jpeg" style="display: none" @change="pickLogo" /></label>
          <button v-if="form.logoDataUrl" class="btn ghost sm" @click="form.logoDataUrl = null"><Icon name="trash" /> Убрать</button>
        </div>
      </div>

      <label class="checkbox" style="margin-bottom: 12px">
        <input v-model="form.hideMarkBranding" type="checkbox" /> Скрыть упоминания MARK (полностью белая метка)
      </label>

      <button class="btn primary block" :disabled="busy" @click="save">
        <span v-if="busy" class="spinner" /><Icon v-else :name="saved ? 'check' : 'sparkles'" /> {{ saved ? 'Сохранено' : 'Сохранить оформление' }}
      </button>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Предпросмотр отчёта</h3>
          <div class="sub">Так увидят документ клиенты</div>
        </div>
      </div>

      <div class="card tight" :style="{ borderColor: form.brandColor, background: `linear-gradient(180deg, ${form.brandColor}22, rgba(17,26,46,0.9))` }">
        <div class="row between">
          <div class="row">
            <img v-if="form.logoDataUrl" :src="form.logoDataUrl" alt="Логотип" style="height: 34px; border-radius: 8px" />
            <div v-else class="logo-mark" :style="{ background: `linear-gradient(140deg, ${form.brandColor}, ${form.accentColor})` }">
              {{ form.agencyName.slice(0, 1).toUpperCase() }}
            </div>
            <div>
              <strong>{{ form.agencyName }}</strong>
              <div class="small faint">{{ form.supportEmail || 'hello@agency.ru' }} · {{ form.supportPhone || '+7 (495) 000-00-00' }}</div>
            </div>
          </div>
          <span class="pill" :style="{ borderColor: form.accentColor, color: form.accentColor }">Отчёт за период</span>
        </div>

        <div class="grid cols-3" style="margin-top: 14px">
          <div class="stat"><span class="label">SEO-балл</span><span class="value">82</span></div>
          <div class="stat"><span class="label">Чистота трафика</span><span class="value">91</span></div>
          <div class="stat"><span class="label">Конверсии</span><span class="value">124</span></div>
        </div>

        <div class="bar" style="margin: 14px 0"><span :style="{ width: '68%', background: `linear-gradient(90deg, ${form.brandColor}, ${form.accentColor})` }" /></div>

        <div class="small muted">
          {{ form.footerNote || 'Отчёт подготовлен автоматически' }}
          <div v-if="form.reportFooter" class="faint" style="margin-top: 6px">{{ form.reportFooter }}</div>
          <div v-if="!form.hideMarkBranding" class="faint" style="margin-top: 6px">Работает на MARK</div>
        </div>
      </div>

      <div class="card tight" style="margin-top: 14px">
        <strong class="small">Что подставляется автоматически</strong>
        <ul class="small muted" style="padding-left: 18px; margin: 6px 0 0">
          <li>Название и логотип — в шапку HTML/PDF-отчёта</li>
          <li>Цвета — в графики и акценты документа</li>
          <li>Подпись и дисклеймер — в подвал каждого отчёта</li>
          <li>Контакты поддержки — в блок «куда обращаться»</li>
        </ul>
      </div>
    </div>
  </div>
</template>
