import { PLATFORMS, type PlatformDef, type PlatformId } from '@mark/shared';
import { httpRequest, tlsCertificateInfo } from '../../http/client.js';
import { rootLogger } from '../../logger.js';

/**
 * Автоматическое определение платформы сайта.
 *
 * Анализируются: HTML, HTTP-заголовки, структура URL, meta generator.
 * Итог — платформа + уверенность + доказательства + рекомендованные коннекторы,
 * чтобы пользователю не пришлось выбирать CMS руками.
 */

const log = rootLogger.child('detect-platform');

export interface PlatformDetection {
  url: string;
  finalUrl: string;
  platform: PlatformId;
  platformName: string;
  confidence: number;
  evidence: string[];
  candidates: { platform: PlatformId; score: number; evidence: string[] }[];
  headers: Record<string, string>;
  https: boolean;
  httpsCertificate?: { daysLeft?: number; issuer?: string; validTo?: string };
  serverInfo?: string;
  cmsMeta?: { generator?: string; cdnHints: string[] };
  recommendedConnectors: string[];
  buildRequired: boolean;
  sitemapUrl?: string | null;
  robotsTxtAvailable?: boolean;
  responseTimeMs?: number;
  htmlBytes?: number;
  statusCode?: number;
  error?: string;
}

const CDN_HINTS: { pattern: RegExp; hint: string }[] = [
  { pattern: /tildacdn\.com/i, hint: 'Tilda CDN' },
  { pattern: /wixstatic\.com|parastorage\.com/i, hint: 'Wix CDN' },
  { pattern: /assets\.website-files\.com/i, hint: 'Webflow CDN' },
  { pattern: /cdn\.shopify\.com/i, hint: 'Shopify CDN' },
  { pattern: /static1\.squarespace\.com/i, hint: 'Squarespace CDN' },
  { pattern: /_next\/static/i, hint: 'Next.js' },
  { pattern: /_nuxt\//i, hint: 'Nuxt' },
  { pattern: /assets\.astro|astro-island/i, hint: 'Astro' },
  { pattern: /cloudfront\.net/i, hint: 'AWS CloudFront' },
  { pattern: /cloudflare/i, hint: 'Cloudflare' },
];

const CMS_META: { pattern: RegExp; cms: string }[] = [
  { pattern: /WordPress\s*([\d.]+)?/i, cms: 'WordPress' },
  { pattern: /Joomla/i, cms: 'Joomla' },
  { pattern: /Drupal/i, cms: 'Drupal' },
  { pattern: /Ghost/i, cms: 'Ghost' },
  { pattern: /Hugo/i, cms: 'Hugo' },
  { pattern: /Jekyll/i, cms: 'Jekyll' },
  { pattern: /Astro/i, cms: 'Astro' },
  { pattern: /Tilda/i, cms: 'Tilda' },
  { pattern: /MODX/i, cms: 'MODX' },
  { pattern: /Bitrix/i, cms: '1C-Битрикс' },
];

export async function detectPlatform(rawUrl: string): Promise<PlatformDetection> {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const origin = new URL(url);
  const evidence: string[] = [];
  const scores = new Map<PlatformId, { score: number; evidence: string[] }>();
  const add = (platform: PlatformId, points: number, note: string) => {
    const current = scores.get(platform) ?? { score: 0, evidence: [] };
    current.score += points;
    current.evidence.push(note);
    scores.set(platform, current);
  };

  const result = await httpRequest<string>(origin.toString(), { raw: true, timeoutMs: 20_000, retries: 1, maxBytes: 4 * 1024 * 1024 });
  const html = result.text ?? '';
  const headers = result.headers ?? {};
  const finalUrl = result.url || origin.toString();

  const serverInfo = headers['server'] ?? '';
  if (serverInfo) evidence.push(`Заголовок Server: ${serverInfo}`);

  // Заголовки
  const headerBlob = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  if (/x-vercel/i.test(headerBlob)) add('nextjs', 25, 'Заголовки Vercel (x-vercel-*)');
  if (/x-nf-request-id/i.test(headerBlob)) add('static-html', 12, 'Заголовки Netlify (x-nf-request-id)');
  if (/x-powered-by:\s*Next\.js/i.test(headerBlob)) add('nextjs', 30, 'X-Powered-By: Next.js');
  if (/x-shopid|x-shardid|x-shopify/i.test(headerBlob)) add('shopify', 35, 'Заголовки Shopify');
  if (/x-wix|wix-/i.test(headerBlob)) add('wix', 25, 'Заголовки Wix');
  if (/ghost/i.test(serverInfo)) add('ghost', 20, 'Server: Ghost');
  if (/wp-|wordpress/i.test(headerBlob)) add('wordpress', 15, 'Заголовки WordPress');

  // URL-сигнатуры
  const path = origin.pathname || '/';
  if (/\.html?$/i.test(path)) add('static-html', 15, 'URL заканчивается на .html');
  if (/\/wp-json|\/wp-content|\/wp-admin/i.test(path)) add('wordpress', 30, 'Путь WordPress в URL');

  // HTML-сигнатуры
  if (html) {
    for (const platform of PLATFORMS) {
      for (const signature of platform.signatures) {
        if (signature.source === 'header') continue;
        if (signature.source === 'url') {
          if (signature.pattern && new RegExp(signature.pattern, 'i').test(path)) add(platform.id, signature.weight, signature.note);
          continue;
        }
        const regex = new RegExp(signature.pattern, 'i');
        if (regex.test(html)) add(platform.id, signature.weight, signature.note);
      }
    }
  }

  // meta generator
  const generatorMatch = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const generator = generatorMatch?.[1];
  if (generator) {
    evidence.push(`meta generator: ${generator}`);
    for (const entry of CMS_META) {
      if (entry.pattern.test(generator)) {
        const mapping: Record<string, PlatformId> = {
          WordPress: 'wordpress',
          Joomla: 'joomla',
          Ghost: 'ghost',
          Hugo: 'hugo',
          Jekyll: 'jekyll',
          Astro: 'astro',
          Tilda: 'tilda',
          MODX: 'modx',
        };
        const mapped = mapping[entry.cms];
        if (mapped) add(mapped, 30, `meta generator: ${entry.cms}`);
      }
    }
  }

  const cdnHints: string[] = [];
  for (const hint of CDN_HINTS) {
    if (hint.pattern.test(html) || hint.pattern.test(headerBlob)) cdnHints.push(hint.hint);
  }
  if (cdnHints.length) evidence.push(`CDN/фреймворк: ${cdnHints.join(', ')}`);

  // robots/sitemap
  let sitemapUrl: string | null = null;
  let robotsTxtAvailable = false;
  if (result.ok) {
    const robots = await httpRequest(`${origin.origin}/robots.txt`, { raw: true, timeoutMs: 10_000, retries: 0 });
    robotsTxtAvailable = robots.ok;
    if (robots.ok) evidence.push('robots.txt доступен');
    const sitemapMatch = /sitemap:\s*(\S+)/i.exec(robots.text ?? '');
    sitemapUrl = sitemapMatch?.[1] ?? null;
    if (sitemapUrl) evidence.push(`sitemap указан в robots.txt: ${sitemapUrl}`);
  }

  // TLS
  let httpsCertificate: PlatformDetection['httpsCertificate'];
  if (origin.protocol === 'https:') {
    const cert = await tlsCertificateInfo(origin.hostname);
    if (cert.supported) {
      httpsCertificate = { daysLeft: cert.daysLeft, issuer: cert.issuer, validTo: cert.validTo };
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const best = sorted[0];
  const platform: PlatformId = best && best[1].score >= 20 ? best[0] : 'unknown';
  const total = sorted.reduce((acc, [, v]) => acc + v.score, 0) || 1;
  const confidence = best ? Math.min(98, Math.round((best[1].score / total) * 100) + Math.min(30, best[1].score)) : 10;
  const platformDef: PlatformDef = PLATFORMS.find((p) => p.id === platform) ?? PLATFORMS[PLATFORMS.length - 1]!;

  log.info(`Платформа ${origin.hostname}: ${platformDef.name} (${confidence}%)`, { evidence: best?.[1].evidence });

  return {
    url,
    finalUrl,
    platform: platformDef.id,
    platformName: platformDef.name,
    confidence,
    evidence: [...evidence, ...(best?.[1].evidence ?? [])],
    candidates: sorted.slice(0, 5).map(([id, value]) => ({ platform: id, score: value.score, evidence: value.evidence })),
    headers,
    https: origin.protocol === 'https:',
    httpsCertificate,
    serverInfo: serverInfo || undefined,
    cmsMeta: { generator, cdnHints },
    recommendedConnectors: platformDef.connectors,
    buildRequired: platformDef.buildRequired,
    sitemapUrl,
    robotsTxtAvailable,
    responseTimeMs: result.durationMs,
    htmlBytes: html ? Buffer.byteLength(html, 'utf8') : 0,
    statusCode: result.status,
    error: result.ok ? undefined : result.error ?? `HTTP ${result.status}`,
  };
}
