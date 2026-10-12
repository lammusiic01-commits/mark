import type { PageSnapshot } from '@mark/shared';

/**
 * Демонстрационный слепок сайта.
 *
 * Нужен, когда реальный сайт недоступен (нет интернета, закрытый staging,
 * тестовый прогон в демо-режиме): аудит всё равно выполняет полный анализ
 * и показывает, какие проблемы и правки MARK умеет находить сам.
 *
 * Слепок помечается флагом simulated, а в отчёт добавляется честное
 * предупреждение — фальшивых выводов по реальному сайту не бывает.
 */

const NAV = [
  { href: '/', internal: true, anchor: 'Главная' },
  { href: '/uslugi/', internal: true, anchor: 'Услуги' },
  { href: '/uslugi/remont-kvartir/', internal: true, anchor: 'Ремонт квартир' },
  { href: '/kontakty/', internal: true, anchor: 'Контакты' },
  { href: '/blog/remont-ceny/', internal: true, anchor: 'Цены на ремонт' },
  { href: 'http://stroy-master.example/old/', internal: true, anchor: 'Старый раздел' },
  { href: 'https://vk.com/stroymaster', internal: false, anchor: 'Мы во ВКонтакте' },
];

function snapshot(url: string, patch: Partial<PageSnapshot>): PageSnapshot {
  return {
    url,
    status: 200,
    title: undefined,
    description: undefined,
    h1: [],
    headings: [],
    canonical: null,
    robotsMeta: null,
    og: {},
    images: [],
    links: NAV,
    scripts: ['/assets/app.js', '/assets/vendor.js'],
    styles: ['/assets/app.css'],
    jsonLd: [],
    textLength: 0,
    wordCount: 0,
    lang: 'ru',
    hasViewport: true,
    isHttps: true,
    ttfbMs: 640,
    loadMs: 2100,
    htmlBytes: 180_000,
    compressed: false,
    hreflang: [],
    geoMeta: {},
    httpsCertificate: { daysLeft: 47, issuer: "Let's Encrypt" },
    ...patch,
  };
}

/** Адреса демонстрационных страниц. */
export function demoPageUrls(baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  return [`${origin}/`, `${origin}/uslugi/`, `${origin}/uslugi/remont-kvartir/`, `${origin}/kontakty/`, `${origin}/blog/remont-ceny/`];
}

export function demoPageSnapshots(baseUrl: string): PageSnapshot[] {
  const origin = new URL(baseUrl).origin;
  const [home, services, apartment, contacts, blog] = demoPageUrls(baseUrl) as [string, string, string, string, string];

  return [
    // Главная: длинный title без города, нет description, два H1, картинки без alt, нет разметки
    snapshot(home, {
      title: 'СтройМастер — ремонт квартир, отделка под ключ, дизайн-проект, ванная под ключ и ещё много всего по приятным ценам в Москве и Московской области',
      description: undefined,
      h1: ['Ремонт квартир под ключ', 'Ремонт квартир — недорого'],
      headings: [
        { level: 1, text: 'Ремонт квартир под ключ' },
        { level: 1, text: 'Ремонт квартир — недорого' },
        { level: 4, text: 'Почему выбирают нас' },
        { level: 2, text: 'Услуги' },
      ],
      images: [
        { src: '/img/hero.jpg', alt: null, loading: null, bytes: 2_400_000 },
        { src: '/img/kitchen.jpg', alt: null, loading: 'lazy', bytes: 1_900_000 },
        { src: 'http://stroy-master.example/img/bath.jpg', alt: 'Ванная', loading: 'lazy', bytes: 1_200_000 },
        { src: '/img/team.jpg', alt: null, loading: null, bytes: 890_000 },
        { src: '/img/schema.png', alt: null, loading: null, bytes: 320_000 },
      ],
      links: NAV,
      textLength: 2400,
      wordCount: 340,
      jsonLd: [],
      og: { 'og:title': 'СтройМастер' },
      hreflang: [],
      ttfbMs: 820,
      htmlBytes: 420_000,
      compressed: true,
    }),

    // Раздел услуг: нет title, дубли H1, нет canonical, мало текста
    snapshot(services, {
      title: undefined,
      description: 'Ремонт квартир, офисов и загородных домов. Полный цикл: от демонтажа до чистовой отделки.',
      h1: ['Услуги', 'Услуги «СтройМастер»'],
      headings: [
        { level: 1, text: 'Услуги' },
        { level: 1, text: 'Услуги «СтройМастер»' },
        { level: 3, text: 'Ремонт квартир' },
      ],
      canonical: null,
      images: [{ src: '/img/services-1.jpg', alt: null, loading: null, bytes: 640_000 }],
      textLength: 420,
      wordCount: 62,
      ttfbMs: 700,
    }),

    // Услуга: title без города, нет FAQ-разметки, нет цен, есть битые ссылки
    snapshot(apartment, {
      title: 'Ремонт квартир под ключ — цены, сроки',
      description: 'Ремонт квартир под ключ: смета за 2 дня, договор, гарантия 3 года. Бригада со своим инструментом.',
      h1: ['Ремонт квартир под ключ'],
      headings: [
        { level: 2, text: 'Цены на ремонт' },
        { level: 2, text: 'Как проходит работа' },
      ],
      images: [
        { src: '/img/flat-1.jpg', alt: null, loading: null, bytes: 1_100_000 },
        { src: '/img/flat-2.jpg', alt: null, loading: null, bytes: 980_000 },
      ],
      links: [...NAV, { href: '/uslugi/remont-kvartir/#otzyvy', internal: true, anchor: 'Отзывы' }],
      textLength: 3100,
      wordCount: 470,
      jsonLd: [{ '@type': 'Service', name: 'Ремонт квартир' }],
      og: { 'og:title': 'Ремонт квартир под ключ', 'og:image': '/img/flat-1.jpg' },
      ttfbMs: 760,
    }),

    // Контакты: нет LocalBusiness, нет телефона в тексте, нет карты, нет geo-меты
    snapshot(contacts, {
      title: 'Контакты — СтройМастер',
      description: 'Свяжитесь с нами: офис в центре, работаем по будням с 9 до 19.',
      h1: ['Контакты'],
      headings: [{ level: 2, text: 'Как нас найти' }],
      images: [{ src: '/img/map.png', alt: 'Карта офиса', loading: 'lazy', bytes: 410_000 }],
      textLength: 620,
      wordCount: 96,
      jsonLd: [],
      geoMeta: {},
      ttfbMs: 690,
    }),

    // Блог: не указан автор и дата, нет разметки Article, тонкий контент, нет FAQ
    snapshot(blog, {
      title: 'Сколько стоит ремонт квартиры в 2026 году',
      description: 'Разбираем, из чего складывается стоимость ремонта и как сэкономить без потери качества.',
      h1: ['Сколько стоит ремонт квартиры'],
      headings: [{ level: 2, text: 'Из чего складывается цена' }],
      images: [{ src: '/img/blog/price.jpg', alt: null, loading: null, bytes: 720_000 }],
      textLength: 1800,
      wordCount: 280,
      jsonLd: [],
      og: {},
      ttfbMs: 720,
    }),
  ];
}

/** robots.txt демо-сайта: sitemap указан, правил для AI-поиска нет. */
export function demoRobotsTxt(baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  return [
    'User-agent: *',
    'Disallow: /wp-admin/',
    'Disallow: /*?from=',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '# AI-боты отдельно не описаны',
    '',
  ].join('\n');
}

/** sitemap.xml демо-сайта: только 3 URL из 5 — этого достаточно для проверки полноты. */
export function demoSitemapXml(baseUrl: string): string {
  const urls = demoPageUrls(baseUrl).slice(0, 3);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${url}</loc><lastmod>2026-01-15</lastmod></url>`),
    '</urlset>',
  ].join('\n');
}
