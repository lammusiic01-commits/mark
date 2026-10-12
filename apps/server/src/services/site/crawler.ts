import * as cheerio from 'cheerio';
import type { PageSnapshot } from '@mark/shared';
import { httpRequest, sleepMs } from '../../http/client.js';
import { config } from '../../config.js';
import { rootLogger } from '../../logger.js';
import { demoPageSnapshots, demoRobotsTxt, demoPageUrls } from './demo-site.js';

/**
 * Небольшой, но честный краулер для аудита:
 *  - уважает robots.txt (Disallow для *), вежливая задержка между запросами;
 *  - ограничивает глубину и число страниц;
 *  - собирает всё, что нужно для проверки SEO/GEO (мета, заголовки, картинки, ссылки, JSON-LD, hreflang).
 */

const log = rootLogger.child('crawler');

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
  crawlDelay: number | null;
  raw: string;
}

export function parseRobotsTxt(content: string): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [], sitemaps: [], crawlDelay: null, raw: content };
  let appliesToAll = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(':');
    const key = (keyRaw ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      appliesToAll = value === '*';
      continue;
    }
    if (key === 'sitemap') {
      rules.sitemaps.push(value);
      continue;
    }
    if (!appliesToAll) continue;
    if (key === 'disallow' && value) rules.disallow.push(value);
    if (key === 'allow' && value) rules.allow.push(value);
    if (key === 'crawl-delay') rules.crawlDelay = Number(value) || null;
  }
  return rules;
}

/** Простая, но корректная проверка: разрешён ли путь по правилам robots.txt. */
export function isAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  const matchLength = (patterns: string[]) =>
    patterns
      .filter((pattern) => {
        const clean = pattern.replace(/\*$/, '');
        return clean === '/' ? true : pathname.startsWith(clean);
      })
      .reduce((max, pattern) => Math.max(max, pattern.replace(/\*$/, '').length), -1);
  const allowLength = matchLength(rules.allow);
  const disallowLength = matchLength(rules.disallow);
  if (disallowLength === -1) return true;
  return allowLength >= disallowLength;
}

function absolutize(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function parseHtml(html: string, url: string, meta: { status: number; ttfbMs?: number; htmlBytes: number }): PageSnapshot {
  const $ = cheerio.load(html);
  const base = $('base[href]').attr('href');
  const baseUrl = base ? absolutize(base, url) ?? url : url;

  const headings: { level: number; text: string }[] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const tag = (el as unknown as { tagName?: string }).tagName ?? 'h1';
    const level = Number(tag.replace('h', '')) || 1;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level, text });
  });

  const images: PageSnapshot['images'] = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') ?? $el.attr('data-src') ?? '';
    if (!src) return;
    images.push({
      src: absolutize(src, baseUrl) ?? src,
      alt: $el.attr('alt') ?? null,
      loading: $el.attr('loading') ?? null,
    });
  });

  const links: PageSnapshot['links'] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    const absolute = absolutize(href, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    seen.add(absolute);
    links.push({
      href: absolute,
      internal: new URL(absolute).hostname === new URL(url).hostname,
      anchor: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const content = $(el).contents().text();
    if (!content) return;
    try {
      jsonLd.push(JSON.parse(content));
    } catch {
      jsonLd.push({ __invalid: content.slice(0, 200) });
    }
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr('hreflang');
    const href = $(el).attr('href');
    if (lang && href) hreflang.push({ lang, href: absolutize(href, baseUrl) ?? href });
  });

  const geoMeta: Record<string, string> = {};
  $('meta[name^="geo"], meta[property^="og:locale"], meta[name="ICBM"]').each((_, el) => {
    const name = $(el).attr('name') ?? $(el).attr('property') ?? '';
    const content = $(el).attr('content') ?? '';
    if (name && content) geoMeta[name] = content;
  });

  const text = $('body').text().replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/\s+/g, ' ').trim();

  return {
    url,
    status: meta.status,
    title: $('title').first().text().trim() || undefined,
    description: $('meta[name="description"]').attr('content')?.trim(),
    h1: $('h1')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean),
    headings: headings.slice(0, 120),
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    robotsMeta: $('meta[name="robots"]').attr('content') ?? null,
    og: $('meta[property^="og:"]')
      .map((_, el) => ({ key: $(el).attr('property') ?? '', value: $(el).attr('content') ?? '' }))
      .get()
      .filter((pair) => Boolean(pair.key))
      .reduce<Record<string, string>>((acc, pair) => {
        acc[pair.key] = pair.value;
        return acc;
      }, {}),
    images: images.slice(0, 200),
    links: links.slice(0, 400),
    scripts: $('script[src]')
      .map((_, el) => $(el).attr('src') ?? '')
      .get()
      .filter(Boolean)
      .map((src) => absolutize(src, baseUrl) ?? src),
    styles: $('link[rel="stylesheet"][href]')
      .map((_, el) => $(el).attr('href') ?? '')
      .get()
      .filter(Boolean)
      .map((href) => absolutize(href, baseUrl) ?? href),
    jsonLd,
    textLength: text.length,
    wordCount: text.split(/\s+/).filter((w) => w.length > 1).length,
    lang: $('html').attr('lang') ?? null,
    hasViewport: $('meta[name="viewport"]').length > 0,
    isHttps: url.startsWith('https://'),
    ttfbMs: meta.ttfbMs,
    htmlBytes: meta.htmlBytes,
    compressed: undefined,
    hreflang,
    geoMeta,
  };
}

export interface CrawlResult {
  baseUrl: string;
  origin: string;
  robots: RobotsRules;
  robotsTxtRaw: string;
  sitemaps: string[];
  pages: PageSnapshot[];
  discovered: string[];
  errors: { url: string; error: string }[];
  blockedByRobots: string[];
  durationMs: number;
  /** true — сайт был недоступен, анализ выполнен на демонстрационном слепке */
  simulated?: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  includeSubdomains?: boolean;
  respectRobots?: boolean;
  delayMs?: number;
  extraPaths?: string[];
  /** Подставлять демонстрационный слепок, если сайт недоступен (по умолчанию — да) */
  demoFallback?: boolean;
}

export async function crawlSite(baseUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const started = Date.now();
  const normalized = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  const origin = new URL(normalized).origin;
  const maxPages = Math.min(options.maxPages ?? config.maxCrawlPages, 200);
  const delayMs = options.delayMs ?? 220;
  const respectRobots = options.respectRobots ?? true;

  const robotsResult = await httpRequest(`${origin}/robots.txt`, { raw: true, timeoutMs: 10_000, retries: 0 });
  const robots = robotsResult.ok ? parseRobotsTxt(robotsResult.text) : parseRobotsTxt('');

  const queue: string[] = [normalized];
  const seen = new Set<string>([normalized]);
  const pages: PageSnapshot[] = [];
  const errors: { url: string; error: string }[] = [];
  const blockedByRobots: string[] = [];
  const sitemapQueue = [...robots.sitemaps];

  // Стартовые страницы: главная + типовые разделы (если они есть)
  for (const extra of options.extraPaths ?? []) {
    const url = absolutize(extra, origin);
    if (url && !seen.has(url)) {
      seen.add(url);
      queue.push(url);
    }
  }

  let lastRequest = 0;

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    const parsed = new URL(url);
    if (respectRobots && !isAllowedByRobots(parsed.pathname, robots)) {
      blockedByRobots.push(url);
      continue;
    }
    const wait = delayMs - (Date.now() - lastRequest);
    if (wait > 0) await sleepMs(wait);
    lastRequest = Date.now();

    const response = await httpRequest<string>(url, {
      raw: true,
      timeoutMs: 20_000,
      retries: 0,
      maxBytes: 6 * 1024 * 1024,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok && !response.text) {
      errors.push({ url, error: response.error ?? `HTTP ${response.status}` });
      continue;
    }
    const contentType = response.headers['content-type'] ?? '';
    if (contentType && !/html|xml|text/i.test(contentType)) continue;

    const snapshot = parseHtml(response.text, url, {
      status: response.status,
      ttfbMs: response.durationMs,
      htmlBytes: Buffer.byteLength(response.text, 'utf8'),
    });
    snapshot.compressed = Boolean(response.headers['content-encoding']);
    pages.push(snapshot);

    // sitemap.xml — источник дополнительных URL
    if (!sitemapQueue.length && pages.length === 1) {
      sitemapQueue.push(`${origin}/sitemap.xml`);
    }

    for (const link of snapshot.links) {
      if (!link.internal) continue;
      const linkUrl = new URL(link.href);
      if (!options.includeSubdomains && linkUrl.hostname !== parsed.hostname) continue;
      if (!/^https?:$/.test(linkUrl.protocol)) continue;
      if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|docx?|xlsx?|css|js|mp4|mp3|woff2?)(\?|$)/i.test(linkUrl.pathname)) continue;
      if (seen.has(linkUrl.toString())) continue;
      seen.add(linkUrl.toString());
      queue.push(linkUrl.toString());
    }
  }

  // Разбор sitemap: берём первые N URL, не попавшие в краул
  const sitemaps = [...new Set(sitemapQueue)];
  const fromSitemap: string[] = [];
  for (const sitemapUrl of sitemaps.slice(0, 5)) {
    const result = await httpRequest<string>(sitemapUrl, { raw: true, timeoutMs: 15_000, retries: 0, maxBytes: 4 * 1024 * 1024 });
    if (!result.ok) continue;
    const locs = [...result.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!).slice(0, 300);
    for (const loc of locs) {
      if (!seen.has(loc)) {
        fromSitemap.push(loc);
        if (pages.length + fromSitemap.length >= maxPages * 3) break;
      }
    }
    // Если sitemap-индекс — забираем вложенные карты
    if (/<sitemapindex/i.test(result.text) && locs.length) {
      for (const child of locs.slice(0, 3)) {
        const childResult = await httpRequest<string>(child, { raw: true, timeoutMs: 15_000, retries: 0, maxBytes: 4 * 1024 * 1024 });
        if (!childResult.ok) continue;
        for (const loc of [...childResult.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!)) {
          if (!seen.has(loc)) fromSitemap.push(loc);
        }
      }
    }
  }

  log.info(`Краул ${origin} завершён: страниц ${pages.length}, времени ${Date.now() - started} мс`);

  const unavailable = pages.length === 0;
  if (unavailable && options.demoFallback !== false) {
    // Сайт недоступен (нет сети, staging за авторизацией, опечатка в адресе).
    // Чтобы аудит не «врал нулями», анализируем демонстрационный слепок и честно помечаем его.
    const demoPages = demoPageSnapshots(normalized);
    log.warn(`Сайт недоступен, использую демонстрационный слепок: ${normalized}`);
    return {
      baseUrl: normalized,
      origin,
      robots: parseRobotsTxt(demoRobotsTxt(normalized)),
      robotsTxtRaw: demoRobotsTxt(normalized),
      sitemaps: [`${origin}/sitemap.xml`],
      pages: demoPages,
      discovered: demoPageUrls(normalized),
      errors: [...errors, { url: normalized, error: 'Сайт недоступен — анализ выполнен на демонстрационном слепке страниц' }],
      blockedByRobots,
      durationMs: Date.now() - started,
      simulated: true,
    };
  }

  return {
    baseUrl: normalized,
    origin,
    robots,
    robotsTxtRaw: robotsResult.text ?? '',
    sitemaps,
    pages,
    discovered: [...new Set([...seen, ...fromSitemap])],
    errors,
    blockedByRobots,
    durationMs: Date.now() - started,
  };
}

/** Проверка только главной страницы (быстро, для онлайн-валидации проекта). */
export async function fetchHomepage(url: string): Promise<PageSnapshot | null> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const response = await httpRequest<string>(normalized, { raw: true, timeoutMs: 20_000, retries: 1, maxBytes: 6 * 1024 * 1024 });
  if (!response.ok || !response.text) return null;
  const snapshot = parseHtml(response.text, normalized, {
    status: response.status,
    ttfbMs: response.durationMs,
    htmlBytes: Buffer.byteLength(response.text, 'utf8'),
  });
  snapshot.compressed = Boolean(response.headers['content-encoding']);
  return snapshot;
}
