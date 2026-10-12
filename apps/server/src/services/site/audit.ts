import type { AuditRun, Finding, PageSnapshot, Severity } from '@mark/shared';
import { ROBOTS_TEMPLATE } from '@mark/shared';
import { httpRequest } from '../../http/client.js';
import { rootLogger } from '../../logger.js';
import { crawlSite, type CrawlResult } from './crawler.js';
import { demoSitemapXml, demoPageUrls } from './demo-site.js';

/**
 * Движок SEO/GEO-аудита.
 *
 * Проверяет техническую часть, индексацию, контент, скорость, мобильную версию,
 * ссылки, локальный SEO (GEO) и готовность к ИИ-поиску (GEO для LLM).
 * Каждое найденное замечание содержит рекомендацию и признак autoFixable,
 * чтобы движок автоисправлений мог применить правку сам.
 */

const log = rootLogger.child('audit');

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 18, high: 10, medium: 5, low: 2, info: 0 };

export interface AuditOptions {
  url: string;
  maxPages?: number;
  includeSubdomains?: boolean;
  runPsi?: boolean;
  keywords?: string[];
  regions?: number[];
  emit?: (type: string, payload: unknown) => void;
}

interface FindingDraft extends Omit<Finding, 'id'> {}

export function scoreFromFindings(findings: Finding[]): { score: number; grade: string; categoryScores: Record<string, number> } {
  const categoryTotals: Record<string, number> = {};
  const categoryPenalty: Record<string, number> = {};
  for (const finding of findings) {
    const weight = SEVERITY_WEIGHT[finding.severity] ?? 2;
    categoryTotals[finding.category] = (categoryTotals[finding.category] ?? 0) + 12;
    categoryPenalty[finding.category] = (categoryPenalty[finding.category] ?? 0) + weight;
  }
  const categoryScores: Record<string, number> = {};
  for (const [category, total] of Object.entries(categoryTotals)) {
    const penalty = categoryPenalty[category] ?? 0;
    categoryScores[category] = Math.max(0, Math.min(100, Math.round(100 - (penalty / Math.max(total, 20)) * 100)));
  }
  const penalty = findings.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] ?? 2), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * 0.9)));
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : score >= 35 ? 'E' : 'F';
  return { score, grade, categoryScores };
}

function textOf(page: PageSnapshot): string {
  return [page.title, page.description, ...page.h1, ...page.headings.map((h) => h.text)].join(' ').toLowerCase();
}

async function checkBrokenLinks(snapshots: PageSnapshot[], limit = 12): Promise<FindingDraft[]> {
  const findings: FindingDraft[] = [];
  const candidates: string[] = [];
  for (const page of snapshots) {
    for (const link of page.links) {
      if (link.internal && !candidates.includes(link.href)) candidates.push(link.href);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }
  for (const url of candidates) {
    const response = await httpRequest(url, { method: 'GET', raw: true, timeoutMs: 12_000, retries: 0, maxBytes: 64 * 1024 });
    if (response.status >= 400 || response.status === 0) {
      findings.push({
        code: 'broken-internal-link',
        title: `Битая внутренняя ссылка (${response.status || 'нет ответа'})`,
        severity: 'high',
        category: 'links',
        url,
        evidence: `Запрос к ${url} вернул ${response.status || response.error}`,
        recommendation: 'Исправьте ссылку или поставьте 301-редирект на актуальную страницу (иначе теряется вес и ломается обход).',
        autoFixable: true,
        impact: 8,
        fix: { type: 'redirect', from: url, to: snapshots.find((p) => p.status < 400)?.url ?? '/' },
      });
    }
  }
  return findings;
}

async function runPsi(url: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await httpRequest<{
      lighthouseResult?: {
        categories?: Record<string, { score?: number }>;
        audits?: Record<string, { numericValue?: number; displayValue?: string }>;
      };
    }>('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
      query: { url, strategy: 'mobile', category: 'performance' },
      timeoutMs: 45_000,
      retries: 0,
    });
    if (!result.ok || !result.data?.lighthouseResult) return null;
    const lh = result.data.lighthouseResult;
    return {
      performance: Math.round((lh.categories?.performance?.score ?? 0) * 100),
      lcp: lh.audits?.['largest-contentful-paint']?.displayValue,
      cls: lh.audits?.['cumulative-layout-shift']?.displayValue,
      tbt: lh.audits?.['total-blocking-time']?.displayValue,
      speedIndex: lh.audits?.['speed-index']?.displayValue,
    };
  } catch (error) {
    log.debug('PSI недоступен', error);
    return null;
  }
}

export async function runAudit(options: AuditOptions): Promise<AuditRun> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const emit = options.emit ?? (() => undefined);
  const findings: FindingDraft[] = [];

  emit('stage', { stage: 'crawl', message: 'Обходим сайт и собираем страницы' });
  const crawl: CrawlResult = await crawlSite(options.url, {
    maxPages: options.maxPages ?? 25,
    includeSubdomains: options.includeSubdomains,
  });
  emit('stage', { stage: 'crawl-done', message: `Собрано страниц: ${crawl.pages.length}`, pages: crawl.pages.length });

  if (crawl.simulated) {
    findings.push({
      code: 'audit-offline',
      title: 'Сайт недоступен: анализ по демонстрационному слепку',
      severity: 'info',
      category: 'technical',
      url: options.url,
      evidence: 'Не удалось получить ни одной страницы сайта (нет сети, staging закрыт паролем или в адресе опечатка)',
      recommendation:
        'Проверьте доступность адреса и повторите аудит: MARK обойдёт реальные страницы и соберёт точные данные. Пока показан полный анализ на демонстрационном слепке — так вы видите, какие проблемы и правки MARK умеет находить.',
      autoFixable: false,
      impact: 0,
    });
  }

  const homepage = crawl.pages[0];
  const origin = crawl.origin;

  emit('stage', { stage: 'psi', message: 'Замеряем скорость загрузки' });
  const psi = options.runPsi === false ? null : await runPsi(origin);

  /* ------------------------- Техническая часть ------------------------- */

  for (const page of crawl.pages) {
    const path = new URL(page.url).pathname;
    if (page.status >= 500) {
      findings.push({
        code: 'server-error',
        title: `Ошибка сервера ${page.status}`,
        severity: 'critical',
        category: 'technical',
        url: page.url,
        evidence: `Страница ${page.url} отвечает ${page.status}`,
        recommendation: 'Страница должна отдавать 200. Ошибки 5xx мешают индексации и снижают доверие к сайту.',
        autoFixable: false,
        impact: 15,
      });
    } else if (page.status >= 400) {
      findings.push({
        code: 'client-error',
        title: `Страница отдаёт ${page.status}`,
        severity: 'high',
        category: 'technical',
        url: page.url,
        evidence: `На страницу ${page.url} ведут ссылки, но она отвечает ${page.status}`,
        recommendation: 'Исправьте URL или настройте 301-редирект: пользователь и робот должны попадать на рабочую страницу.',
        autoFixable: true,
        impact: 9,
        fix: { type: 'redirect', from: page.url, to: origin },
      });
    }

    if (!page.isHttps) {
      findings.push({
        code: 'no-https',
        title: 'Страница отдаётся по HTTP',
        severity: 'critical',
        category: 'security',
        url: page.url,
        evidence: `${page.url} работает без TLS`,
        recommendation: 'Включите HTTPS и 301-редирект с HTTP — это требование браузеров, рекламных систем и поиска.',
        autoFixable: true,
        impact: 14,
        fix: { type: 'redirect', from: page.url.replace(/^http:/, 'http:'), to: page.url.replace(/^http:/, 'https:') },
      });
    }

    if (page.robotsMeta && /noindex/i.test(page.robotsMeta)) {
      if (path === '/' || crawl.pages.length <= 3) {
        findings.push({
          code: 'homepage-noindex',
          title: 'На важной странице стоит noindex',
          severity: 'critical',
          category: 'indexing',
          url: page.url,
          evidence: `meta robots: ${page.robotsMeta}`,
          recommendation: 'Уберите noindex: с ним страница никогда не попадёт в поиск.',
          autoFixable: true,
          impact: 16,
          fix: { type: 'meta-robots', url: page.url, value: 'index,follow' },
        });
      }
    }

    if (!page.canonical) {
      findings.push({
        code: 'no-canonical',
        title: 'Нет canonical',
        severity: 'medium',
        category: 'technical',
        url: page.url,
        evidence: 'Страница без link rel=canonical',
        recommendation: `Добавьте <link rel="canonical" href="${page.url}"> — это защищает от дублей при UTM и пагинации.`,
        autoFixable: true,
        impact: 5,
        fix: { type: 'canonical', url: page.url, canonical: page.url },
      });
    } else {
      try {
        const canonicalUrl = new URL(page.canonical, page.url);
        if (canonicalUrl.origin !== new URL(page.url).origin) {
          findings.push({
            code: 'canonical-cross-domain',
            title: 'Canonical ведёт на другой домен',
            severity: 'high',
            category: 'indexing',
            url: page.url,
            evidence: `canonical = ${page.canonical}`,
            recommendation: 'Проверьте: если это не осознанная склейка зеркал, canonical должен указывать на тот же сайт.',
            autoFixable: true,
            impact: 10,
            fix: { type: 'canonical', url: page.url, canonical: page.url },
          });
        }
      } catch {
        /* некорректный canonical поймаем ниже */
      }
    }

    if (page.hreflang.length) {
      const missingSelf = !page.hreflang.some((h) => h.href.replace(/\/$/, '') === page.url.replace(/\/$/, ''));
      if (missingSelf) {
        findings.push({
          code: 'hreflang-no-self',
          title: 'hreflang без self-reference',
          severity: 'medium',
          category: 'geo',
          url: page.url,
          evidence: `На странице ${page.url} нет hreflang-ссылки на саму себя`,
          recommendation: 'Каждая страница в hreflang-наборе должна ссылаться и на себя, иначе Google может проигнорировать всю разметку.',
          autoFixable: true,
          impact: 6,
          fix: { type: 'hreflang-add', url: page.url, href: page.url, lang: page.lang ?? 'ru' },
        });
      }
      const noReturn = page.hreflang.filter((h) => h.href.startsWith(origin) && !crawl.pages.some((p) => p.url === h.href));
      if (noReturn.length) {
        findings.push({
          code: 'hreflang-broken',
          title: 'hreflang указывает на недоступные страницы',
          severity: 'medium',
          category: 'geo',
          url: page.url,
          evidence: noReturn.map((h) => h.href).join(', '),
          recommendation: 'Ссылки hreflang должны вести на существующие локализованные версии — иначе региональный таргетинг не сработает.',
          autoFixable: false,
          impact: 5,
        });
      }
    }

    /* -------------------------- Контент и мета -------------------------- */

    const titleLen = page.title?.length ?? 0;
    if (!page.title) {
      findings.push({
        code: 'title-missing',
        title: 'Нет title',
        severity: 'critical',
        category: 'content',
        url: page.url,
        evidence: 'Тег <title> пуст или отсутствует',
        recommendation: 'Пропишите title 30–60 символов с ключевым запросом и регионом — это главный фактор клика в выдаче.',
        autoFixable: true,
        impact: 15,
        fix: { type: 'title', url: page.url, value: '' },
      });
    } else if (titleLen > 70) {
      findings.push({
        code: 'title-too-long',
        title: `Слишком длинный title (${titleLen} символов)`,
        severity: 'medium',
        category: 'content',
        url: page.url,
        evidence: page.title!,
        recommendation: 'Сократите до 60–65 символов: лишнее Яндекс и Google обрежут, потеряв ключевые слова в конце.',
        autoFixable: true,
        impact: 5,
        fix: { type: 'title', url: page.url, value: page.title!.slice(0, 62) },
      });
    } else if (titleLen < 20) {
      findings.push({
        code: 'title-too-short',
        title: `Короткий title (${titleLen} символов)`,
        severity: 'low',
        category: 'content',
        url: page.url,
        evidence: page.title!,
        recommendation: 'Добавьте уточнение (услуга + город), чтобы title занимал выдачу целиком.',
        autoFixable: true,
        impact: 3,
        fix: { type: 'title', url: page.url, value: page.title! },
      });
    }

    if (!page.description) {
      findings.push({
        code: 'description-missing',
        title: 'Нет description',
        severity: 'medium',
        category: 'content',
        url: page.url,
        evidence: 'meta name="description" отсутствует',
        recommendation: 'Добавьте описание 120–170 символов с выгодой и призывом — оно влияет на CTR.',
        autoFixable: true,
        impact: 6,
        fix: { type: 'description', url: page.url, value: '' },
      });
    } else if ((page.description?.length ?? 0) > 200) {
      findings.push({
        code: 'description-too-long',
        title: 'Слишком длинный description',
        severity: 'low',
        category: 'content',
        url: page.url,
        evidence: `${page.description!.length} символов`,
        recommendation: 'Сократите до 160–170 символов, чтобы он не обрезался в сниппете.',
        autoFixable: true,
        impact: 3,
        fix: { type: 'description', url: page.url, value: page.description!.slice(0, 168) },
      });
    }

    if (page.h1.length === 0) {
      findings.push({
        code: 'h1-missing',
        title: 'Нет H1',
        severity: 'high',
        category: 'content',
        url: page.url,
        evidence: 'На странице не найден заголовок первого уровня',
        recommendation: 'Добавьте один H1 с главным запросом страницы — он помогает и поиску, и ИИ-моделям понять тему.',
        autoFixable: true,
        impact: 8,
        fix: { type: 'h1', url: page.url, value: page.title ?? '' },
      });
    } else if (page.h1.length > 1) {
      findings.push({
        code: 'h1-multiple',
        title: `Несколько H1 (${page.h1.length})`,
        severity: 'medium',
        category: 'content',
        url: page.url,
        evidence: page.h1.join(' | ').slice(0, 200),
        recommendation: 'Оставьте один главный H1, остальные сделайте H2 — так структура понятнее для поиска и ИИ.',
        autoFixable: false,
        impact: 4,
      });
    }

    if (page.wordCount < 250 && page.status < 400) {
      findings.push({
        code: 'thin-content',
        title: `Мало текста (${page.wordCount} слов)`,
        severity: 'medium',
        category: 'content',
        url: page.url,
        evidence: `Объём текста: ${page.wordCount} слов`,
        recommendation: 'Добавьте 600–1000 слов по интенту запроса: поиск и LLM-ответы опираются на полноту ответа.',
        autoFixable: false,
        impact: 6,
      });
    }

    const ratio = page.htmlBytes > 0 ? page.textLength / page.htmlBytes : 0;
    if (ratio < 0.04 && page.wordCount < 150) {
      findings.push({
        code: 'js-only-content',
        title: 'Контент, вероятно, рендерится JavaScript-ом',
        severity: 'high',
        category: 'generative',
        url: page.url,
        evidence: `Текст занимает ${(ratio * 100).toFixed(1)}% HTML (${page.textLength} символов)`,
        recommendation:
          'Добавьте SSR/пререндер. ИИ-краулеры (GPTBot, PerplexityBot) не выполняют JS — ваш контент для них невидим, а значит вы не попадёте в AI-ответы.',
        autoFixable: false,
        impact: 11,
      });
    }

    /* ---------------------------- Картинки ---------------------------- */

    const withoutAlt = page.images.filter((image) => !image.alt && !/\.(svg)$/i.test(image.src));
    if (withoutAlt.length) {
      findings.push({
        code: 'images-no-alt',
        title: `${withoutAlt.length} изображений без alt`,
        severity: withoutAlt.length > 5 ? 'medium' : 'low',
        category: 'content',
        url: page.url,
        evidence: withoutAlt.slice(0, 4).map((i) => i.src).join(', '),
        recommendation: 'Пропишите alt с ключевым словом: это и доступность, и картинки в поиске, и понимание контента моделями.',
        autoFixable: true,
        impact: 4,
        fix: { type: 'image-alt', url: page.url, images: withoutAlt.slice(0, 30).map((i) => i.src) },
      });
    }

    const withoutLazy = page.images.filter((image) => !image.loading && page.images.indexOf(image) >= 4);
    if (withoutLazy.length > 3) {
      findings.push({
        code: 'images-no-lazy',
        title: `${withoutLazy.length} изображений без lazy-loading`,
        severity: 'low',
        category: 'speed',
        url: page.url,
        evidence: 'Ниже первого экрана картинки грузятся сразу',
        recommendation: 'Добавьте loading="lazy" для изображений ниже первого экрана — ускоряет LCP и снижает расход трафика.',
        autoFixable: true,
        impact: 4,
        fix: { type: 'image-lazy', url: page.url, images: withoutLazy.slice(0, 40).map((i) => i.src) },
      });
    }

    /* ------------------------------ Скорость ------------------------------ */

    if (page.ttfbMs !== undefined && page.ttfbMs > 900) {
      findings.push({
        code: 'slow-ttfb',
        title: `Медленный ответ сервера (${page.ttfbMs} мс)`,
        severity: page.ttfbMs > 2000 ? 'high' : 'medium',
        category: 'speed',
        url: page.url,
        evidence: `TTFB ${page.ttfbMs} мс`,
        recommendation: 'Включите кэш страниц (или CDN), оптимизируйте запросы к БД. Цель — TTFB до 400–600 мс.',
        autoFixable: true,
        impact: 7,
        fix: { type: 'server-headers', url: page.url, headers: { 'Cache-Control': 'public, max-age=3600' } },
      });
    }

    if (!page.compressed && page.htmlBytes > 60_000) {
      findings.push({
        code: 'no-compression',
        title: 'Нет сжатия ответа',
        severity: 'medium',
        category: 'speed',
        url: page.url,
        evidence: `Размер HTML ${(page.htmlBytes / 1024).toFixed(0)} КБ, content-encoding отсутствует`,
        recommendation: 'Включите gzip/brotli на сервере — HTML сжимается в 3–5 раз, что напрямую ускоряет загрузку.',
        autoFixable: true,
        impact: 6,
        fix: { type: 'server-config', file: '.htaccess', snippet: 'mod_deflate' },
      });
    }

    if (page.styles.length > 6) {
      findings.push({
        code: 'many-stylesheets',
        title: `${page.styles.length} внешних CSS-файлов`,
        severity: 'low',
        category: 'speed',
        url: page.url,
        evidence: page.styles.slice(0, 6).join(', '),
        recommendation: 'Объедините и минифицируйте CSS: каждый файл — отдельный блокирующий запрос.',
        autoFixable: false,
        impact: 4,
      });
    }

    if (page.scripts.length > 15) {
      findings.push({
        code: 'many-scripts',
        title: `${page.scripts.length} внешних скриптов`,
        severity: 'medium',
        category: 'speed',
        url: page.url,
        evidence: page.scripts.slice(0, 6).join(', '),
        recommendation: 'Отложите некритичные скрипты (defer/async) и перенесите счётчики через тег-менеджер.',
        autoFixable: true,
        impact: 5,
        fix: { type: 'script-defer', url: page.url },
      });
    }

    /* ----------------------------- Мобильная ----------------------------- */

    if (!page.hasViewport) {
      findings.push({
        code: 'no-viewport',
        title: 'Нет meta viewport',
        severity: 'critical',
        category: 'mobile',
        url: page.url,
        evidence: 'meta name="viewport" не найден',
        recommendation: 'Добавьте <meta name="viewport" content="width=device-width, initial-scale=1"> — без этого мобильная версия не индексируется корректно.',
        autoFixable: true,
        impact: 13,
        fix: { type: 'meta-add', url: page.url, html: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
      });
    }

    /* -------------------------------- GEO -------------------------------- */

    const hasLocalBusiness = JSON.stringify(page.jsonLd).match(/LocalBusiness|Organization|Store|Dentist|LegalService|AutoRepair/i);
    if (path === '/' && !hasLocalBusiness) {
      findings.push({
        code: 'no-local-schema',
        title: 'Нет разметки организации (LocalBusiness/Organization)',
        severity: 'high',
        category: 'geo',
        url: page.url,
        evidence: 'JSON-LD с LocalBusiness не найден',
        recommendation:
          'Добавьте Schema.org LocalBusiness с адресом, телефоном, гео-координатами и часами работы — это усиливает локальную выдачу и карточки в Яндекс.Бизнес/Google.',
        autoFixable: true,
        impact: 9,
        fix: { type: 'json-ld', url: page.url, schema: 'LocalBusiness' },
      });
    }

    const hasContacts = /tel:/.test(JSON.stringify(page.links)) || page.links.some((l) => l.href.startsWith('tel:'));
    if (path === '/' && !hasContacts) {
      findings.push({
        code: 'no-clickable-phone',
        title: 'Нет кликабельного телефона',
        severity: 'low',
        category: 'geo',
        url: page.url,
        evidence: 'Ссылка tel: не найдена',
        recommendation: 'Оформите телефон ссылкой tel: — это упрощает звонок с мобильных и подтверждает локальность бизнеса.',
        autoFixable: true,
        impact: 3,
        fix: { type: 'content-block', url: page.url },
      });
    }

    const regionKeywords = /москв|петербург|спб|казан|екатеринбург|новосибирск|нижн|самар|ростов|краснодар|уфа|челябинск/i;
    if (options.regions?.length && path === '/' && !regionKeywords.test(textOf(page))) {
      findings.push({
        code: 'no-region-signals',
        title: 'Нет региональных сигналов на главной',
        severity: 'medium',
        category: 'geo',
        url: page.url,
        evidence: 'В title/H1/тексте нет названия города или региона',
        recommendation: 'Добавьте город в title, H1 и контакты, создайте региональные страницы — так MARK усилит локальную выдачу.',
        autoFixable: true,
        impact: 5,
        fix: { type: 'content-block', url: page.url },
      });
    }

    /* --------------------------- GEO для ИИ --------------------------- */

    const hasFaq = JSON.stringify(page.jsonLd).includes('FAQPage');
    if (path === '/' && !hasFaq) {
      findings.push({
        code: 'no-faq-schema',
        title: 'Нет FAQPage-разметки',
        severity: 'medium',
        category: 'generative',
        url: page.url,
        evidence: 'FAQPage в JSON-LD не найден',
        recommendation:
          'Добавьте блок «вопрос-ответ» с разметкой FAQPage — ИИ-поиск (ChatGPT, Яндекс Нейро, Perplexity) активно цитирует такие блоки.',
        autoFixable: true,
        impact: 6,
        fix: { type: 'json-ld', url: page.url, schema: 'FAQPage' },
      });
    }

    const questionHeadings = page.headings.filter((h) => /^(как|что|почему|зачем|сколько|какой|когда|где|можно ли|чем)\b/i.test(h.text));
    if (questionHeadings.length === 0 && page.wordCount > 300) {
      findings.push({
        code: 'no-question-headings',
        title: 'Нет заголовков-вопросов',
        severity: 'low',
        category: 'generative',
        url: page.url,
        evidence: 'В структуре нет H2/H3 в форме вопроса',
        recommendation: 'Переформулируйте часть подзаголовков в вопросы и сразу отвечайте на них — это повышает шанс попасть в AI-ответ.',
        autoFixable: false,
        impact: 3,
      });
    }

    if (page.jsonLd.length > 0 && page.jsonLd.some((block) => JSON.stringify(block).includes('__invalid'))) {
      findings.push({
        code: 'invalid-json-ld',
        title: 'Некорректный JSON-LD',
        severity: 'medium',
        category: 'technical',
        url: page.url,
        evidence: 'Один из блоков JSON-LD не парсится',
        recommendation: 'Проверьте разметку валидатором — ошибки в JSON-LD игнорируются и не дают улучшенного сниппета.',
        autoFixable: false,
        impact: 4,
      });
    }
  }

  /* ------------------------------ Дубли ------------------------------ */

  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  for (const page of crawl.pages) {
    if (page.title) titles.set(page.title, [...(titles.get(page.title) ?? []), page.url]);
    if (page.description) descriptions.set(page.description, [...(descriptions.get(page.description) ?? []), page.url]);
  }
  for (const [title, urls] of titles) {
    if (urls.length > 1) {
      findings.push({
        code: 'duplicate-title',
        title: `Дублирующийся title на ${urls.length} страницах`,
        severity: 'high',
        category: 'indexing',
        evidence: `«${title.slice(0, 80)}» встречается на: ${urls.slice(0, 4).join(', ')}`,
        recommendation: 'Уникализируйте title (услуга + город + уточнение). Дубли размывают релевантность и приводят к каннибализации запросов.',
        autoFixable: true,
        impact: 9,
        fix: { type: 'title', urls, value: title },
      });
    }
  }
  for (const [description, urls] of descriptions) {
    if (urls.length > 1) {
      findings.push({
        code: 'duplicate-description',
        title: `Дублирующийся description на ${urls.length} страницах`,
        severity: 'medium',
        category: 'indexing',
        evidence: `«${description.slice(0, 80)}» встречается на: ${urls.slice(0, 4).join(', ')}`,
        recommendation: 'Сделайте описания уникальными: они влияют на CTR в сниппете.',
        autoFixable: true,
        impact: 5,
        fix: { type: 'description', urls, value: description },
      });
    }
  }

  /* ------------------------- robots / sitemap / llms ------------------------- */

  if (!crawl.robotsTxtRaw) {
    findings.push({
      code: 'no-robots',
      title: 'Нет robots.txt',
      severity: 'high',
      category: 'technical',
      url: `${origin}/robots.txt`,
      evidence: 'Файл не найден или отдаёт ошибку',
      recommendation: 'Создайте robots.txt со ссылкой на sitemap и правилами для AI-ботов — MARK сгенерирует готовый файл.',
      autoFixable: true,
      impact: 8,
      fix: { type: 'robots', content: ROBOTS_TEMPLATE(`${origin}/sitemap.xml`) },
    });
  } else {
    if (!/sitemap:/i.test(crawl.robotsTxtRaw)) {
      findings.push({
        code: 'robots-no-sitemap',
        title: 'В robots.txt нет ссылки на sitemap',
        severity: 'medium',
        category: 'indexing',
        url: `${origin}/robots.txt`,
        evidence: 'Директива Sitemap отсутствует',
        recommendation: `Добавьте строку Sitemap: ${origin}/sitemap.xml — ускоряет обнаружение новых страниц.`,
        autoFixable: true,
        impact: 6,
        fix: { type: 'robots', content: ROBOTS_TEMPLATE(`${origin}/sitemap.xml`) },
      });
    }
    if (!/(OAI-SearchBot|PerplexityBot|Claude-SearchBot)/i.test(crawl.robotsTxtRaw)) {
      findings.push({
        code: 'robots-no-ai-search',
        title: 'В robots.txt не разрешён AI-поиск',
        severity: 'low',
        category: 'generative',
        url: `${origin}/robots.txt`,
        evidence: 'Нет правил для OAI-SearchBot / PerplexityBot / Claude-SearchBot',
        recommendation:
          'Явно разрешите ботов AI-поиска: они приводят переходы и цитируют ваш сайт в ответах ChatGPT/Perplexity. Обучение LLM при этом можно запретить.',
        autoFixable: true,
        impact: 4,
        fix: { type: 'robots', content: ROBOTS_TEMPLATE(`${origin}/sitemap.xml`, true, true) },
      });
    }
  }

  const sitemapCheck = crawl.simulated
    ? { ok: true, status: 200, text: demoSitemapXml(crawl.baseUrl), headers: {}, url: `${origin}/sitemap.xml`, durationMs: 0, error: undefined }
    : await httpRequest(`${origin}/sitemap.xml`, { raw: true, timeoutMs: 12_000, retries: 0, maxBytes: 4 * 1024 * 1024 });
  const sitemapUrls = sitemapCheck.ok ? [...sitemapCheck.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!) : [];
  if (!sitemapCheck.ok) {
    findings.push({
      code: 'no-sitemap',
      title: 'Sitemap.xml недоступен',
      severity: 'high',
      category: 'indexing',
      url: `${origin}/sitemap.xml`,
      evidence: `Запрос вернул ${sitemapCheck.status || sitemapCheck.error}`,
      recommendation: 'Сгенерируйте sitemap.xml со всеми важными URL и датой изменения — MARK сделает это автоматически.',
      autoFixable: true,
      impact: 9,
      fix: { type: 'sitemap', urls: crawl.pages.map((p) => p.url) },
    });
  } else if (sitemapUrls.length && crawl.discovered.length > sitemapUrls.length * 1.5) {
    findings.push({
      code: 'sitemap-incomplete',
      title: 'Sitemap покрывает не все страницы',
      severity: 'medium',
      category: 'indexing',
      url: `${origin}/sitemap.xml`,
      evidence: `В sitemap ${sitemapUrls.length} URL, обнаружено ${crawl.discovered.length}`,
      recommendation: 'Обновите sitemap: в него должны попадать все страницы, которые вы хотите видеть в поиске.',
      autoFixable: true,
      impact: 6,
      fix: { type: 'sitemap', urls: crawl.discovered },
    });
  }

  const llmsCheck = crawl.simulated
    ? { ok: false, status: 404, text: '', headers: {}, url: `${origin}/llms.txt`, durationMs: 0, error: 'Файла нет (демонстрационный слепок)' }
    : await httpRequest(`${origin}/llms.txt`, { raw: true, timeoutMs: 10_000, retries: 0, maxBytes: 512 * 1024 });
  if (!llmsCheck.ok) {
    findings.push({
      code: 'no-llms-txt',
      title: 'Нет llms.txt',
      severity: 'medium',
      category: 'generative',
      url: `${origin}/llms.txt`,
      evidence: 'Стандарт llms.txt не реализован',
      recommendation:
        'Добавьте llms.txt: это карта сайта для языковых моделей. Помогает LLM правильно понять структуру и цитировать вас в ответах.',
      autoFixable: true,
      impact: 6,
      fix: { type: 'llms', pages: crawl.pages.slice(0, 20).map((p) => ({ url: p.url, title: p.title ?? p.url })) },
    });
  }

  /* ------------------------------- Ссылки ------------------------------- */

  emit('stage', { stage: 'links', message: 'Проверяем внутренние ссылки' });
  if (crawl.simulated) {
    findings.push({
      code: 'broken-internal-links',
      title: 'Внутренние ссылки ведут на несуществующие страницы',
      severity: 'high',
      category: 'links',
      url: crawl.pages[0]?.url ?? origin,
      evidence: `Проверено ссылок: 8, битых: 2 (${demoPageUrls(crawl.baseUrl)[0]}/old/, /uslugi/snyat-kvartiru/)`,
      recommendation:
        'Уберите ссылки на удалённые страницы или поставьте редиректы 301 на актуальные разделы. Битые ссылки тратят краулинговый бюджет.',
      autoFixable: true,
      impact: 8,
      fix: { type: 'redirects', redirects: [{ from: `${origin}/old/`, to: `${origin}/` }, { from: `${origin}/uslugi/snyat-kvartiru/`, to: `${origin}/uslugi/` }] },
    });
  } else {
    findings.push(...(await checkBrokenLinks(crawl.pages)));
  }

  if (homepage && homepage.links.filter((l) => l.internal).length < 8) {
    findings.push({
      code: 'few-internal-links',
      title: 'Мало внутренних ссылок с главной',
      severity: 'medium',
      category: 'links',
      url: homepage.url,
      evidence: `Внутренних ссылок: ${homepage.links.filter((l) => l.internal).length}`,
      recommendation: 'Добавьте ссылки на ключевые разделы/услуги — так распределяется внутренний вес и ускоряется индексация.',
      autoFixable: false,
      impact: 5,
    });
  }

  /* --------------------- Безопасность / заголовки --------------------- */

  if (homepage) {
    const missingHeaders: string[] = [];
    // Заголовки смотрим ещё раз по главной
    if (crawl.simulated) {
      missingHeaders.push('strict-transport-security', 'content-security-policy', 'x-content-type-options');
    } else {
      const headResponse = await httpRequest(origin, { method: 'HEAD', timeoutMs: 12_000, retries: 0, raw: true });
      for (const header of ['strict-transport-security', 'x-content-type-options', 'content-security-policy', 'referrer-policy']) {
        if (!headResponse.headers[header]) missingHeaders.push(header);
      }
    }
    if (missingHeaders.length) {
      findings.push({
        code: 'missing-security-headers',
        title: `Нет заголовков безопасности (${missingHeaders.length})`,
        severity: 'low',
        category: 'security',
        url: origin,
        evidence: missingHeaders.join(', '),
        recommendation:
          'Добавьте заголовки безопасности. Помимо защиты, это сигнал качества для поисковых систем. Для HTTPS обязательно HSTS.',
        autoFixable: true,
        impact: 3,
        fix: { type: 'server-headers', url: origin, headers: { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' } },
      });
    }

    const mixed = homepage.links.filter((l) => l.href.startsWith('http://')).length;
    const mixedAssets = [...homepage.scripts, ...homepage.styles, ...homepage.images.map((i) => i.src)].filter((u) => u.startsWith('http://')).length;
    if (homepage.isHttps && mixed + mixedAssets > 0) {
      findings.push({
        code: 'mixed-content',
        title: 'Смешанный контент (http на https-странице)',
        severity: 'high',
        category: 'security',
        url: homepage.url,
        evidence: `Небезопасных ресурсов: ${mixedAssets}, ссылок: ${mixed}`,
        recommendation: 'Переведите все ресурсы на https: браузеры блокируют смешанный контент, а поиск помечает страницу как небезопасную.',
        autoFixable: true,
        impact: 9,
        fix: {
          type: 'mixed-content',
          url: homepage.url,
          assets: [...homepage.scripts, ...homepage.styles, ...homepage.images.map((i) => i.src)].filter((u) => u.startsWith('http://')).slice(0, 50),
        },
      });
    }

    if (homepage.httpsCertificate?.daysLeft !== undefined && homepage.httpsCertificate.daysLeft < 21) {
      findings.push({
        code: 'cert-expiring',
        title: `Сертификат HTTPS истекает через ${homepage.httpsCertificate.daysLeft} дн.`,
        severity: homepage.httpsCertificate.daysLeft < 7 ? 'critical' : 'high',
        category: 'security',
        url: origin,
        evidence: `Действует до ${homepage.httpsCertificate.validTo ?? 'неизвестно'} (${homepage.httpsCertificate.issuer ?? ''})`,
        recommendation: 'Настройте автопродление сертификата (Let’s Encrypt) — просроченный сертификат блокирует сайт в браузерах.',
        autoFixable: false,
        impact: 10,
      });
    }
  }

  /* ------------------------- PSI / Core Web Vitals ------------------------- */

  if (psi) {
    const performance = Number(psi.performance ?? 0);
    if (performance > 0 && performance < 60) {
      findings.push({
        code: 'psi-low',
        title: `PageSpeed (мобильные) ${performance}/100`,
        severity: performance < 40 ? 'high' : 'medium',
        category: 'speed',
        url: origin,
        evidence: `LCP: ${psi.lcp ?? '—'}, CLS: ${psi.cls ?? '—'}, TBT: ${psi.tbt ?? '—'}`,
        recommendation: 'Оптимизируйте LCP (главная картинка/шрифт) и CLS (размеры изображений, резервирование места).',
        autoFixable: true,
        impact: 7,
        fix: { type: 'perf-hints', url: origin, psi },
      });
    }
  }

  const severityCount = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length,
    autoFixable: findings.filter((f) => f.autoFixable).length,
  };

  const finalized: Finding[] = findings.map((finding, index) => ({ ...finding, id: `f${index + 1}` }));
  const { score, grade, categoryScores } = scoreFromFindings(finalized);

  const sitemapFound = sitemapCheck.ok ? `${origin}/sitemap.xml` : null;

  log.info(`Аудит ${origin}: ${findings.length} замечаний, балл ${score} (${grade}), ${Date.now() - t0} мс`);
  emit('finished', { score, grade, findings: finalized.length });

  return {
    id: `audit_${Date.now()}`,
    tenantId: '',
    siteProjectId: '',
    status: 'done',
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: crawl.baseUrl,
    pagesCrawled: crawl.pages.length,
    pagesDiscovered: crawl.discovered.length,
    score,
    grade,
    findings: finalized,
    categoryScores,
    summary: severityCount,
    robotsTxt: crawl.robotsTxtRaw || null,
    sitemapFound,
    sitemapsDetected: crawl.sitemaps,
    errors: crawl.errors.map((e) => `${e.url}: ${e.error}`),
  };
}
