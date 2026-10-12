/**
 * Инструкции «где взять ключ» для каждого сервиса.
 *
 * Пользователи мини-приложения — не разработчики: у большинства маркетологов
 * и владельцев бизнеса шаг «получите OAuth-токен» вызывает ступор. Поэтому
 * у каждого сервиса есть пошаговая инструкция с прямыми ссылками, а поля
 * подписаны так, как эти данные называются в интерфейсе сервиса.
 */

export interface ServiceInstruction {
  /** Прямая ссылка на страницу, где выдаётся ключ */
  url?: string;
  /** Что произойдёт после подключения */
  effect: string;
  /** Шаги получения доступа */
  steps: string[];
  /** Частые ошибки и подсказки */
  tips?: string[];
  /** Пример значения, чтобы пользователь понимал формат */
  sample?: string;
}

export const INSTRUCTIONS: Record<string, ServiceInstruction> = {
  'yandex-direct': {
    url: 'https://oauth.yandex.ru/client/new',
    effect: 'MARK сможет читать статистику кампаний, менять ставки и останавливать сливающие фразы по вашим правилам.',
    steps: [
      'Откройте oauth.yandex.ru/client/new под аккаунтом, у которого есть доступ к Директу.',
      'Название: «AI Маркетолог». Платформа: «Веб-сервисы». Redirect URI: https://oauth.yandex.ru/verification_code',
      'В доступах отметьте «Яндекс Директ» — полный доступ (yandex_direct:api).',
      'Создайте приложение и скопируйте ClientID.',
      'Откройте адрес вида oauth.yandex.ru/authorize?response_type=token&client_id=ВАШ_CLIENTID, нажмите «Разрешить».',
      'Скопируйте токен из адресной строки — это текст после access_token= до символа &.',
    ],
    tips: [
      'Токен действует год. Если он «сломался» — просто получите новый по той же ссылке.',
      'Если в аккаунте несколько логинов, укажите тот, где лежат кампании.',
    ],
    sample: 'y0_AgAAAABc...',
  },
  'yandex-metrika': {
    url: 'https://oauth.yandex.ru/client/new',
    effect: 'Маркетолог увидит реальные визиты и конверсии, а не только клики из рекламы.',
    steps: [
      'Токен берётся тот же, что для Директа — но в приложении добавьте доступ «Метрика: чтение» (metrika:read).',
      'Номер счётчика: metrika.yandex.ru → выберите счётчик сайта → «Настройки» → номер вида 12345678.',
      'Введите токен и номер счётчика в полях ниже.',
    ],
    tips: ['Один счётчик — один сайт. Для нескольких сайтов добавьте их по очереди в разделе «Подключения».'],
    sample: 'счётчик 98765432',
  },
  'yandex-webmaster': {
    url: 'https://oauth.yandex.ru/client/new',
    effect: 'MARK отправит XML-фид, проверит ошибки индексации и попросит переобход важных страниц.',
    steps: [
      'В том же приложении добавьте доступ «Вебмастер» (webmaster:verify, webmaster:hostinfo).',
      'Вставьте токен ниже и подтвердите подключение.',
    ],
  },
  'yandex-business': {
    url: 'https://business.yandex.ru',
    effect: 'Карточки организации в Яндексе: адреса, часы работы, фото, отзывы — по всем городам.',
    steps: [
      'Подключение выполняется входом в окне приложения: логин и пароль Яндекса вводите только на странице Яндекса.',
      'После входа MARK сам найдёт карточки, к которым у вас есть доступ.',
    ],
    tips: ['Если включена двухфакторная аутентификация — подтвердите вход в приложении Яндекса.'],
  },
  'google-ads': {
    url: 'https://ads.google.com/aw/apicenter',
    effect: 'Управление кампаниями Google Ads и выгрузка отчётов в единый дашборд.',
    steps: [
      'В Google Ads откройте «Инструменты» → «Центр API» и запросите developer token (выдаётся сразу для тестового доступа).',
      'Client ID и Client secret создайте в Google Cloud Console → «APIs & Services» → «Credentials» → OAuth client ID (тип Web application).',
      'Скопируйте номер MCC-аккаунта (вида 123-456-7890) в поле Login customer ID.',
      'Вставьте developer token, client id и secret ниже и подтвердите подключение.',
    ],
    tips: ['Для тестового developer token данные приходят только из тестового аккаунта — для боевых данных запросите базовый доступ (1–3 дня).'],
  },
  'google-analytics': {
    url: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    effect: 'Визиты, источники и конверсии GA4 в сводке агентства.',
    steps: [
      'Google Cloud Console → «IAM & Admin» → «Service Accounts» → создайте аккаунт.',
      'Ключи → «Add key» → JSON, скачайте файл.',
      'В GA4: «Администратор» → «Управление доступом» → добавьте сервисный аккаунт с правами «Просмотр».',
      'Вставьте содержимое JSON-файла и Property ID (вида properties/123456789).',
    ],
    tips: ['Property ID — не номер потока данных. Он есть в GA4 → «Администратор» → «Настройки ресурса».'],
  },
  'google-search-console': {
    url: 'https://search.google.com/search-console',
    effect: 'Позиции, показы и проблемы индексации прямо из Search Console.',
    steps: [
      'В Google Cloud включите Search Console API и создайте сервисный аккаунт с ключом JSON.',
      'В Search Console добавьте e-mail сервисного аккаунта как пользователя сайта с полными правами.',
      'Вставьте JSON-ключ ниже.',
    ],
  },
  'google-business-profile': {
    url: 'https://business.google.com',
    effect: 'Карточки компании в Google Maps и Поиске: правки, фото, ответы на отзывы.',
    steps: ['Подключение выполняется входом в окне приложения — данные Google вводятся только на странице Google.'],
  },
  'vk-ads': {
    url: 'https://ads.vk.com/account/settings',
    effect: 'Кампании ВКонтакте: статистика, ставки, автостоп неэффективных объявлений.',
    steps: [
      'Откройте ads.vk.com → «Настройки» → «API» → создайте токен с правами ads, offline.',
      'Скопируйте access token и номер кабинета из URL: ads.vk.com/hq/account/7888888 — кабинет 7888888.',
    ],
    sample: 'vk1.a.XXXX',
  },
  'vk-metrika': {
    url: 'https://metrika.vk.ru',
    effect: 'Статистика счётчика VK Метрики и цели по конверсиям.',
    steps: ['Создайте токен в настройках кабинета VK Рекламы с доступом к метрике либо возьмите счётчик и токен у разработчика.'],
  },
  telegram: {
    url: 'https://t.me/BotFather',
    effect: 'Бот пришлёт сводку, примет команды и откроет это приложение прямо в чате.',
    steps: [
      'Откройте @BotFather в Telegram и отправьте /newbot.',
      'Придумайте имя и username бота (заканчивается на bot).',
      'BotFather пришлёт токен вида 123456789:AA... — скопируйте его.',
      'Вставьте токен ниже: MARK поднимет бота и настроит кнопку приложения.',
    ],
    tips: [
      'Чтобы приложение открывалось внутри бота, задайте переменную MARK_PUBLIC_URL с адресом сервера (HTTPS).',
      'Из России для Bot API включите прокси: MARK_TELEGRAM_API_BASE=https://ваш-воркер.workers.dev',
    ],
    sample: '7712345678:AAH...',
  },
  openai: {
    url: 'https://openrouter.ai/keys',
    effect: 'AI-советник объяснит цифры и подскажет, что попробовать дальше. Ядро работает и без AI.',
    steps: [
      'Бесплатный вариант: зарегистрируйтесь на openrouter.ai и создайте ключ в разделе Keys (модели :free не требуют оплаты).',
      'Вставьте ключ вида sk-or-v1-... в поле ниже.',
    ],
    tips: ['Можно оставить поле пустым: тогда советы формируются движком MARK из ваших цифр.'],
    sample: 'sk-or-v1-...',
  },
  'yandex-gpt': {
    url: 'https://yandex.cloud/ru/docs/foundation-models',
    effect: 'AI-советник на YandexGPT — без обращения к зарубежным сервисам.',
    steps: [
      'В Yandex Cloud создайте сервисный аккаунт с ролью ai.languageModels.user.',
      'Создайте API-ключ и folder id, вставьте оба значения ниже.',
    ],
  },
  'email-smtp': {
    url: 'https://mail.yandex.ru',
    effect: 'Отчёты и алерты уходят клиентам на почту от вашего домена.',
    steps: [
      'В Яндекс Почте для домена: «Все настройки» → «Почтовые программы» → включите доступ по IMAP/SMTP и создайте пароль приложения.',
      'Введите хост, порт 465, логин и пароль приложения.',
    ],
    tips: ['Пароль от почты не подойдёт — нужен именно пароль приложения.'],
  },
  tilda: {
    url: 'https://tilda.cc/identity/apikey/',
    effect: 'MARK сам вносит правки на страницы Tilda: мета-теги, robots, разметку и новые блоки.',
    steps: [
      'Откройте Настройки сайта → «Экспорт / API» → «API-ключ» (ссылка выше).',
      'Скопируйте Public и Secret key, вставьте оба.',
      'Проверка проходит по вашему аккаунту и указывает, какие сайты и страницы доступны.',
    ],
    sample: 'public: secret:',
  },
  wordpress: {
    url: 'https://wordpress.org/plugins/application-passwords/',
    effect: 'Правки страниц WordPress через REST API — от мета-тегов до новых разделов.',
    steps: [
      'В админке сайта: «Пользователи» → «Профиль» → «Пароли приложений» → создайте пароль для MARK.',
      'Введите адрес сайта, логин и полученный пароль.',
    ],
    tips: ['Если паролей приложений нет — сайт на старой версии WordPress или их отключил плагин безопасности.'],
  },
  vercel: {
    url: 'https://vercel.com/account/tokens',
    effect: 'MARK задеплоит новые страницы и правки прямо в проект Vercel.',
    steps: ['Откройте vercel.com → «Settings» → «Tokens» → «Create token» с правами Full Access.', 'Скопируйте токен и укажите проект.'],
  },
  netlify: {
    url: 'https://app.netlify.com/user/applications#personal-access-tokens',
    effect: 'Публикация новых страниц и правок на Netlify без ручной сборки.',
    steps: ['Netlify → «User settings» → «Applications» → «Personal access tokens» → «New access token».', 'Скопируйте токен и выберите сайт.'],
  },
  github: {
    url: 'https://github.com/settings/tokens',
    effect: 'Файлы сайта и патчи MARK уезжают прямо в репозиторий.',
    steps: ['GitHub → «Settings» → «Developer settings» → «Personal access tokens (classic)» → «Generate new token» с правом repo.', 'Скопируйте токен вида ghp_... и укажите владельца и репозиторий.'],
  },
  webflow: {
    url: 'https://webflow.com/dashboard/site-settings/apps',
    effect: 'Обновление SEO-полей и создание страниц в Webflow.',
    steps: ['Откройте настройки сайта → «Apps & integrations» → «API access» → сгенерируйте токен.', 'Скопируйте токен и Site ID.'],
  },
  cloudflare: {
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    effect: 'Правки DNS и кэша, загрузка файлов на хостинг Cloudflare Pages.',
    steps: ['Cloudflare → «My Profile» → «API Tokens» → «Create Token» → шаблон «Edit zone DNS» + Pages Edit.', 'Скопируйте токен и zone id нужного домена.'],
  },
  'ftp-hosting': {
    effect: 'Загрузка файлов и правок на обычный хостинг (любой: Beget, Timeweb, reg.ru).',
    steps: [
      'В панели хостинга найдите раздел FTP/SSH и создайте отдельного пользователя для MARK.',
      'Введите хост, порт (21 для FTP, 22 для SFTP), логин, пароль и каталог сайта (например /www/site.ru).',
    ],
    tips: ['Права пользователя ограничьте каталогом сайта — так безопаснее.'],
  },
  indexnow: {
    url: 'https://www.indexnow.org/documentation',
    effect: 'Поисковики узнают о новых страницах за минуты, а не за дни.',
    steps: ['Ключ IndexNow — любая строка из 8–128 символов, придумайте её сами.', 'Разместите файл с ключом в корне сайта или подтвердите e-mail домена.'],
    sample: 'a1b2c3d4e5f6',
  },
};

/** Короткая инструкция по умолчанию, если сервиса нет в списке. */
export function instructionFor(serviceId: string, fallbackName: string): ServiceInstruction {
  return (
    INSTRUCTIONS[serviceId] ?? {
      effect: `Подключение ${fallbackName} в MARK.`,
      steps: ['Откройте настройки сервиса, создайте ключ доступа и вставьте его в поля ниже.', 'Если в сервисе есть режим тестового доступа — включайте его: MARK умеет работать без боевых изменений.'],
    }
  );
}

/** Первые шаги онбординга: что просим настроить в первую очередь. */
export const FIRST_RUN_STEPS = ['yandex-direct', 'yandex-metrika', 'tilda'] as const;
