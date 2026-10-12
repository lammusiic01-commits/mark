import type { AuditRun, Finding, GeoPlan, PatchBundle, PatchFile, PageSnapshot } from '@mark/shared';
import { ROBOTS_TEMPLATE, LLMS_TXT_TEMPLATE } from '@mark/shared';
import { rootLogger } from '../../logger.js';

/**
 * Генератор автоисправлений.
 *
 * На вход — замечания аудита (и/или GEO-план). На выходе — PatchBundle:
 *  - готовые файлы (robots.txt, sitemap.xml, llms.txt, .htaccess, JSON-LD, сниппеты шаблонов);
 *  - план применения коннекторами (git-коммит, FTP-загрузка, WordPress REST, Tilda-редактор, Cloudflare);
 *  - инструкции «руками» для платформ без API;
 *  - список проверок после применения.
 */

const log = rootLogger.child('autofix');

export interface AutofixInput {
  siteUrl: string;
  siteName: string;
  findings: Finding[];
  pages?: PageSnapshot[];
  geoPlan?: GeoPlan | null;
  keywords?: string[];
  regions?: { id: number; name: string }[];
  niche?: string;
  contact?: { phone?: string; address?: string; lat?: number; lon?: number; email?: string };
}

interface GeneratedFiles {
  files: PatchFile[];
  instructions: string[];
  connectorPlan: PatchBundle['connectorPlan'];
  verification: string[];
  /** HTML-вставки, применяемые коннектором в <head> / <body> */
  headInjections: Record<string, string>;
  metaUpdates: { url: string; title?: string; description?: string; robots?: string }[];
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

function buildOrganizationSchema(input: AutofixInput) {
  const url = trimSlash(input.siteUrl);
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.siteName,
    url: `${url}/`,
    description: `Официальный сайт ${input.siteName}`,
  };
  if (input.regions?.length) {
    schema.areaServed = input.regions.map((region) => ({ '@type': 'AdministrativeArea', name: region.name }));
  }
  if (input.contact?.phone) {
    schema.telephone = input.contact.phone;
    schema.contactPoint = [
      { '@type': 'ContactPoint', telephone: input.contact.phone, contactType: 'customer service', availableLanguage: ['ru'] },
    ];
  }
  if (input.contact?.email) schema.email = input.contact.email;
  if (input.contact?.address) {
    schema.address = { '@type': 'PostalAddress', streetAddress: input.contact.address, addressCountry: 'RU' };
  }
  if (input.contact?.lat && input.contact?.lon) {
    schema.geo = { '@type': 'GeoCoordinates', latitude: input.contact.lat, longitude: input.contact.lon };
  }
  return schema;
}

function buildLocalBusinessSchema(input: AutofixInput) {
  const url = trimSlash(input.siteUrl);
  const region = input.regions?.[0];
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: input.siteName,
    url: `${url}/`,
    image: `${url}/og-image.jpg`,
    telephone: input.contact?.phone ?? '+7 (000) 000-00-00',
    priceRange: '₽₽',
    address: {
      '@type': 'PostalAddress',
      streetAddress: input.contact?.address ?? 'укажите улицу, дом',
      addressLocality: region?.name ?? 'Москва',
      addressCountry: 'RU',
    },
    ...(input.contact?.lat && input.contact?.lon
      ? { geo: { '@type': 'GeoCoordinates', latitude: input.contact.lat, longitude: input.contact.lon } }
      : {}),
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '09:00',
        closes: '19:00',
      },
    ],
    areaServed: (input.regions ?? []).map((r) => ({ '@type': 'AdministrativeArea', name: r.name })),
  };
}

function buildFaqSchema(input: AutofixInput) {
  const topic = input.keywords?.[0] ?? input.niche ?? 'услуга';
  const region = input.regions?.[0]?.name ?? 'Москва';
  const qa = [
    {
      q: `Сколько стоит ${topic} в ${region}?`,
      a: `Стоимость зависит от объёма работ. Оставьте заявку — рассчитаем точную цену за 15 минут и предложим варианты бюджета.`,
    },
    {
      q: `Как быстро вы можете приступить к работе?`,
      a: `Обычно старт возможен уже на следующий день после согласования. Срочные задачи берём в работу в день обращения.`,
    },
    {
      q: `Какие гарантии вы даёте?`,
      a: `Работаем по договору с фиксированной сметой и гарантией на результат. Все этапы фиксируются в отчётности.`,
    },
    {
      q: `Работаете ли вы по ${region} и области?`,
      a: `Да, выезжаем по городу и области. Для удалённых заказов организуем дистанционное сопровождение и доставку.`,
    },
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

function buildBreadcrumbSchema(input: AutofixInput, pages: PageSnapshot[]) {
  const url = trimSlash(input.siteUrl);
  return pages
    .filter((page) => new URL(page.url).pathname !== '/')
    .slice(0, 12)
    .map((page) => ({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Главная', item: `${url}/` },
        { '@type': 'ListItem', position: 2, name: page.title ?? page.url, item: page.url },
      ],
    }));
}

function generateSitemap(urls: string[], defaultChangefreq = 'weekly') {
  const today = new Date().toISOString().slice(0, 10);
  const unique = [...new Set(urls)].slice(0, 5000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${unique
  .map(
    (url) => `  <url>
    <loc>${url.replace(/&/g, '&amp;')}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${defaultChangefreq}</changefreq>
    <priority>${url.endsWith('/') ? '1.0' : '0.8'}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`;
}

function generateHtaccess(origin: string) {
  return `# .htaccess — сгенерировано MARK
# Сжатие
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css text/javascript application/javascript application/json image/svg+xml
</IfModule>

# Кэширование статики
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/jpeg "access plus 1 year"
  ExpiresByType image/webp "access plus 1 year"
  ExpiresByType text/css "access plus 1 year"
  ExpiresByType application/javascript "access plus 1 year"
  ExpiresByType text/html "access plus 1 hour"
</IfModule>

# Заголовки безопасности
<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "geolocation=(self), microphone=(), camera=()"
</IfModule>

# HTTPS
RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^(.*)$ https://%{HTTP_HOST}/$1 [R=301,L]

# Единое зеркало без www
RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]
RewriteRule ^(.*)$ https://%1/$1 [R=301,L]

# Редиректы со старых адресов (дополняется MARK)
# Redirect 301 /old-page/ ${origin}/new-page/

# Файл для IndexNow
<FilesMatch "^[A-Za-z0-9-]{8,128}\\.txt$">
  Header set Content-Type "text/plain; charset=utf-8"
</FilesMatch>

ErrorDocument 404 /404.html
`;
}

function generateNginxSnippet() {
  return `# nginx — сгенерировано MARK (вставьте в server {})
gzip on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;

location ~* \\.(jpg|jpeg|png|webp|avif|gif|svg|ico|woff2?)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# Переброс на HTTPS
server {
    listen 80;
    server_name example.ru www.example.ru;
    return 301 https://example.ru$request_uri;
}
`;
}

function generateNextJsSnippets(pages: PageSnapshot[]) {
  const withMissingMeta = pages.filter((p) => !p.title || !p.description).slice(0, 5);
  const example = withMissingMeta[0]?.url ?? 'https://example.ru/';
  return `// app/sitemap.ts — динамическая карта сайта (Next.js App Router)
import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = '${trimSlash(example)}'.replace(/\\/$/, '');
  const routes = ['/', '/about', '/contacts']; // ← замените на реальные маршруты
  return routes.map((route) => ({
    url: \`\${base}\${route}\`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: route === '/' ? 1 : 0.8,
  }));
}
`;
}

function generateRobotsTxt(urls: { origin: string; sitemapUrl: string; allowAiSearch: boolean; blockAiTraining: boolean }) {
  return ROBOTS_TEMPLATE(urls.sitemapUrl, urls.allowAiSearch, urls.blockAiTraining);
}

function generateLlmsTxt(input: AutofixInput, pages: PageSnapshot[]) {
  const base = trimSlash(input.siteUrl);
  const region = input.regions?.[0]?.name;
  return LLMS_TXT_TEMPLATE(
    input.siteName,
    base,
    `${input.siteName}${region ? ` — работаем в ${region}` : ''}${input.niche ? `. Направление: ${input.niche}` : ''}. Ключевые услуги и контакты — ниже.`,
    pages.slice(0, 20).map((page) => ({
      title: page.title ?? new URL(page.url).pathname,
      url: page.url,
      note: (page.description ?? page.h1[0] ?? 'Страница сайта').slice(0, 160),
    })),
  );
}

function suggestTitle(page: PageSnapshot, input: AutofixInput): string {
  const region = input.regions?.[0]?.name ?? '';
  const keyword = input.keywords?.[0] ?? input.niche ?? '';
  const existing = page.title?.trim() ?? '';
  if (existing) {
    const withRegion = region && !existing.toLowerCase().includes(region.toLowerCase()) ? `${existing} — ${region}` : existing;
    return withRegion.slice(0, 62);
  }
  const brand = input.siteName;
  const candidate = keyword ? `${keyword}${region ? ` в ${region}` : ''} — ${brand}` : `${brand}${region ? ` — ${region}` : ''}`;
  return candidate.slice(0, 62);
}

function suggestDescription(page: PageSnapshot, input: AutofixInput): string {
  const region = input.regions?.[0]?.name ?? 'вашем городе';
  const keyword = input.keywords?.[0] ?? input.niche ?? 'услуги';
  return `${keyword}${region ? ` в ${region}` : ''}: опытные специалисты, договор и гарантия. Бесплатный расчёт стоимости и консультация — оставьте заявку на сайте ${input.siteName}.`.slice(
    0,
    168,
  );
}

export function buildPatchBundle(input: AutofixInput): PatchBundle {
  const origin = new URL(input.siteUrl.startsWith('http') ? input.siteUrl : `https://${input.siteUrl}`).origin;
  const pages = input.pages ?? [];
  const codes = new Set(input.findings.map((f) => f.code));
  const files: PatchFile[] = [];
  const instructions: string[] = [];
  const connectorPlan: PatchBundle['connectorPlan'] = [];
  const verification: string[] = [];
  const headInjections: Record<string, string> = {};
  const metaUpdates: { url: string; title?: string; description?: string; robots?: string }[] = [];

  /* robots.txt */
  if (codes.has('no-robots') || codes.has('robots-no-sitemap') || codes.has('robots-no-ai-search')) {
    const content = generateRobotsTxt({
      origin,
      sitemapUrl: `${origin}/sitemap.xml`,
      allowAiSearch: true,
      blockAiTraining: true,
    });
    files.push({ path: 'robots.txt', content, contentType: 'text/plain', action: 'update', target: 'site' });
    connectorPlan.push({ step: 'Обновление robots.txt', connectorId: 'auto', action: 'write-file', payload: { path: 'robots.txt' } });
    verification.push('Откройте /robots.txt и убедитесь, что появилась директива Sitemap и правила для AI-ботов');
  }

  /* sitemap.xml */
  if (codes.has('no-sitemap') || codes.has('sitemap-incomplete')) {
    const urls = (pages.length ? pages.map((p) => p.url) : [origin, `${origin}/`]).filter((url) => !/[?&]/.test(url));
    files.push({ path: 'sitemap.xml', content: generateSitemap(urls.length ? urls : [origin]), contentType: 'application/xml', action: 'update', target: 'site' });
    connectorPlan.push({ step: 'Загрузка sitemap.xml', connectorId: 'auto', action: 'write-file', payload: { path: 'sitemap.xml' } });
    connectorPlan.push({ step: 'Отправка sitemap в Яндекс.Вебмастер и Google Search Console', connectorId: 'yandex-webmaster', action: 'submit-sitemap', payload: { sitemapUrl: `${origin}/sitemap.xml` } });
    verification.push('Sitemap доступен по /sitemap.xml и отправлен в Вебмастер/GSC');
  }

  /* llms.txt */
  if (codes.has('no-llms-txt')) {
    const content = generateLlmsTxt(input, pages);
    files.push({ path: 'llms.txt', content, contentType: 'text/plain', action: 'create', target: 'site' });
    connectorPlan.push({ step: 'Публикация llms.txt', connectorId: 'auto', action: 'write-file', payload: { path: 'llms.txt' } });
    verification.push('Файл /llms.txt отдаёт 200 и содержит описание сайта и разделов');
  }

  /* Schema.org */
  if (codes.has('no-local-schema')) {
    const local = JSON.stringify(buildLocalBusinessSchema(input), null, 2);
    const organization = JSON.stringify(buildOrganizationSchema(input), null, 2);
    headInjections['index.html'] = `<script type="application/ld+json">\n${local}\n</script>\n<script type="application/ld+json">\n${organization}\n</script>`;
    files.push({
      path: 'schema-local-business.json',
      content: local,
      contentType: 'application/json',
      action: 'create',
      target: 'manual',
    });
    connectorPlan.push({ step: 'Вставка JSON-LD в <head> главной', connectorId: 'auto', action: 'inject-head', payload: { url: `${origin}/`, schema: 'LocalBusiness' } });
    verification.push('Проверьте разметку в Яндекс.Вебмастере → «Структурированные данные» и в Rich Results Test');
  }

  if (codes.has('no-faq-schema')) {
    const faq = JSON.stringify(buildFaqSchema(input), null, 2);
    files.push({ path: 'schema-faq.json', content: faq, contentType: 'application/json', action: 'create', target: 'manual' });
    connectorPlan.push({ step: 'Вставка FAQPage JSON-LD', connectorId: 'auto', action: 'inject-head', payload: { url: `${origin}/`, schema: 'FAQPage' } });
    instructions.push(
      'Добавьте на главную блок «Частые вопросы» с 4–6 вопросами (текст подготовлен в schema-faq.json) — не только разметку, но и видимый контент.',
    );
  }

  const breadcrumbs = buildBreadcrumbSchema(input, pages);
  if (breadcrumbs.length) {
    files.push({
      path: 'schema-breadcrumbs.json',
      content: JSON.stringify(breadcrumbs, null, 2),
      contentType: 'application/json',
      action: 'create',
      target: 'manual',
    });
  }

  /* Заголовки безопасности / сжатие / HTTPS */
  if (codes.has('missing-security-headers') || codes.has('no-compression') || codes.has('cert-expiring')) {
    files.push({ path: '.htaccess', content: generateHtaccess(origin), contentType: 'text/plain', action: 'update', target: 'hosting' });
    files.push({ path: 'nginx-mark.conf', content: generateNginxSnippet(), contentType: 'text/plain', action: 'create', target: 'hosting' });
    connectorPlan.push({ step: 'Применение конфигурации сервера', connectorId: 'ftp-hosting', action: 'write-file', payload: { path: '.htaccess' } });
    verification.push('Проверьте заголовки в ответе сервера (HSTS, X-Content-Type-Options) и gzip на HTML');
  }

  if (codes.has('slow-ttfb') || codes.has('psi-low')) {
    files.push({
      path: 'speed-report.json',
      content: JSON.stringify({ generatedAt: new Date().toISOString(), findings: input.findings.filter((f) => f.category === 'speed') }, null, 2),
      contentType: 'application/json',
      action: 'create',
      target: 'manual',
    });
  }

  /* Мета-теги страниц */
  const metaFindings = input.findings.filter((f) =>
    ['title-missing', 'title-too-long', 'title-too-short', 'duplicate-title', 'description-missing', 'description-too-long', 'duplicate-description', 'no-viewport'].includes(f.code),
  );
  if (metaFindings.length) {
    const byUrl = new Map<string, PageSnapshot>();
    for (const page of pages) byUrl.set(page.url, page);
    const targets = new Set<string>();
    for (const finding of metaFindings) {
      if (finding.url) targets.add(finding.url);
      const urls = (finding.fix as { urls?: string[] } | null)?.urls;
      urls?.forEach((url) => targets.add(url));
    }
    for (const url of [...targets].slice(0, 40)) {
      const page = byUrl.get(url) ?? ({ url, title: undefined, h1: [], images: [], links: [], headings: [] } as unknown as PageSnapshot);
      const update = {
        url,
        title: suggestTitle(page, input),
        description: suggestDescription(page, input),
        robots: page.robotsMeta && /noindex/i.test(page.robotsMeta) ? 'index,follow' : undefined,
      };
      metaUpdates.push(update);
    }
    files.push({
      path: 'seo-meta-updates.json',
      content: JSON.stringify(metaUpdates, null, 2),
      contentType: 'application/json',
      action: 'create',
      target: 'cms',
    });
    files.push({
      path: 'seo-meta-updates.csv',
      content: `url;title;description;robots\n${metaUpdates
        .map((u) => `${u.url};${u.title ?? ''};${u.description ?? ''};${u.robots ?? ''}`)
        .join('\n')}`,
      contentType: 'text/csv',
      action: 'create',
      target: 'cms',
    });
    connectorPlan.push({ step: 'Запись title/description через коннектор платформы', connectorId: 'auto', action: 'update-meta', payload: { count: metaUpdates.length } });
    verification.push(`Проверьте ${metaUpdates.length} страниц: title 30–60 символов, description 120–170`);
  }

  /* Битые ссылки и редиректы */
  const redirects = input.findings
    .filter((f) => f.fix && (f.fix as { type?: string }).type === 'redirect')
    .map((f) => f.fix as { from: string; to: string });
  if (redirects.length) {
    files.push({
      path: 'redirects.txt',
      content: redirects.map((r) => `${r.from} → ${r.to}`).join('\n'),
      contentType: 'text/plain',
      action: 'create',
      target: 'hosting',
    });
    connectorPlan.push({ step: 'Настройка 301-редиректов', connectorId: 'cloudflare', action: 'create-redirects', payload: { redirects } });
  }

  /* Смешанный контент */
  const mixed = input.findings.find((f) => f.code === 'mixed-content');
  if (mixed?.fix) {
    const assets = (mixed.fix as { assets?: string[] }).assets ?? [];
    files.push({
      path: 'mixed-content-fixes.json',
      content: JSON.stringify(
        assets.map((asset) => ({ from: asset, to: asset.replace(/^http:/, 'https:') })),
        null,
        2,
      ),
      contentType: 'application/json',
      action: 'create',
      target: 'manual',
    });
    instructions.push('Замените http:// на https:// в указанных ресурсах (файл mixed-content-fixes.json) или обновите их подключение в шаблоне.');
  }

  /* Alt у изображений и lazy-loading */
  const altFinding = input.findings.find((f) => f.code === 'images-no-alt');
  if (altFinding?.fix) {
    const images = (altFinding.fix as { images?: string[] }).images ?? [];
    files.push({
      path: 'image-alt-suggestions.csv',
      content: `image;alt\n${images
        .map((src, index) => `${src};${input.keywords?.[index % (input.keywords.length || 1)] ?? input.niche ?? 'изображение услуги'}`)
        .join('\n')}`,
      contentType: 'text/csv',
      action: 'create',
      target: 'manual',
    });
  }

  /* GEO-план: региональные страницы */
  if (input.geoPlan) {
    for (const page of input.geoPlan.pages.slice(0, 60)) {
      files.push({
        path: `geo-pages/${page.url.split('/').filter(Boolean).pop() || 'index'}.html`,
        content: `<!-- Региональная страница: ${page.regionName} -->
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${page.title}</title>
  <meta name="description" content="${page.description}">
  <link rel="canonical" href="${page.url}">
</head>
<body>
  <h1>${page.h1}</h1>
  <p><strong>${input.siteName}</strong> — ${page.regionName}. Ключевые направления: ${page.keywords.join(', ')}.</p>
  <p>Звоните: <a href="tel:${input.contact?.phone ?? '+70000000000'}">${input.contact?.phone ?? '+7 (000) 000-00-00'}</a></p>
  <script type="application/ld+json">
  ${JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: `${input.siteName} — ${page.regionName}`,
      url: page.url,
      areaServed: { '@type': 'AdministrativeArea', name: page.regionName },
    },
    null,
    2,
  )}
  </script>
</body>
</html>`,
        contentType: 'text/html',
        action: 'create',
        target: 'site',
      });
    }
    connectorPlan.push({
      step: 'Публикация региональных страниц',
      connectorId: 'auto',
      action: 'publish-pages',
      payload: { count: input.geoPlan.pages.length },
    });
    verification.push('Региональные страницы отдают 200, содержат город в title/H1 и добавлены в sitemap');
  }

  /* Сниппеты для современных фреймворков */
  if (pages.length) {
    files.push({ path: 'nextjs-sitemap.ts', content: generateNextJsSnippets(pages), contentType: 'text/typescript', action: 'create', target: 'repo' });
  }

  instructions.push(
    'Если коннектор недоступен — файлы из этого пакета можно загрузить вручную: они лежат в .data/reports и в ZIP-выгрузке отчёта.',
  );
  if (!verification.length) verification.push('Повторите аудит MARK через 24–48 часов: балл должен вырасти, а замечания — исчезнуть.');

  const bundle: PatchBundle = {
    id: `patch_${Date.now()}`,
    siteProjectId: input.siteUrl,
    createdAt: new Date().toISOString(),
    files,
    instructions,
    connectorPlan,
    verification,
  };

  log.info(`Сформирован пакет исправлений: файлов ${files.length}, шагов коннекторов ${connectorPlan.length}`);

  // headInjections и metaUpdates отдаём через payload-расширение
  (bundle as unknown as { headInjections?: Record<string, string>; metaUpdates?: typeof metaUpdates }).headInjections = headInjections;
  (bundle as unknown as { metaUpdates?: typeof metaUpdates }).metaUpdates = metaUpdates;
  return bundle;
}

/** Быстрая сводка: сколько замечаний и что можно исправить автоматически. */
export function summarizeAutofix(findings: Finding[]) {
  const autoFixable = findings.filter((f) => f.autoFixable);
  const byCategory: Record<string, number> = {};
  for (const finding of autoFixable) {
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
  }
  return {
    total: findings.length,
    autoFixable: autoFixable.length,
    byCategory,
    codes: autoFixable.map((f) => f.code),
  };
}

export function auditToAutofixInput(audit: AuditRun, extras: Omit<AutofixInput, 'findings' | 'siteUrl' | 'siteName'> & { siteUrl: string; siteName: string }): AutofixInput {
  return { ...extras, findings: audit.findings };
}
