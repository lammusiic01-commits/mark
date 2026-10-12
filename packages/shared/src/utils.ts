/** Чистые утилиты, общие для сервера и клиента (без Node API). */

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const round = (v: number, digits = 2) => {
  const k = 10 ** digits;
  return Math.round((v + Number.EPSILON) * k) / k;
};

export const safeDivide = (a: number, b: number, fallback = 0) => (b === 0 ? fallback : a / b);

export const percent = (part: number, total: number, digits = 1) => round(safeDivide(part, total) * 100, digits);

export const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

export const mean = (arr: number[]) => (arr.length ? sum(arr) / arr.length : 0);

export const median = (arr: number[]) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const quantile = (arr: number[], q: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
};

export const unique = <T>(arr: T[]) => Array.from(new Set(arr));

export const groupBy = <T, K extends string | number>(arr: T[], key: (item: T) => K) => {
  const out = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
};

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/* --------------------------- даты --------------------------- */

export const toISODate = (d: Date | string | number) => {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
};

export const addDays = (d: Date | string, days: number) => {
  const date = d instanceof Date ? new Date(d.getTime()) : new Date(d);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
};

export const daysBetween = (from: Date | string, to: Date | string) => {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
};

export const dateSeries = (from: string, to: string) => {
  const out: string[] = [];
  let cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  let guard = 0;
  while (cur <= end && guard < 4000) {
    out.push(cur.toISOString().slice(0, 10));
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
};

export const monthKey = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 7);

/* ---------------------- статистика A/B ---------------------- */

/** Функция ошибок (Abramowitz & Stegun 7.1.26) */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Двусторонний p-value для z-статистики */
export const zToPValue = (z: number) => round(2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2))), 6);

/**
 * Z-тест для двух долей (конверсия/CTR).
 * Возвращает z-статистику, p-value и признак значимости на уровне 0.05.
 */
export function twoProportionZTest(
  control: { visitors: number; conversions: number },
  variant: { visitors: number; conversions: number },
  alpha = 0.05,
) {
  const n1 = control.visitors;
  const n2 = variant.visitors;
  if (n1 <= 0 || n2 <= 0) {
    return { z: 0, pValue: 1, significant: false, liftPercent: 0, controlRate: 0, variantRate: 0 };
  }
  const p1 = control.conversions / n1;
  const p2 = variant.conversions / n2;
  const pooled = (control.conversions + variant.conversions) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const pValue = zToPValue(z);
  return {
    z: round(z, 4),
    pValue,
    significant: pValue < alpha,
    liftPercent: p1 === 0 ? 0 : round(((p2 - p1) / p1) * 100, 2),
    controlRate: round(p1 * 100, 3),
    variantRate: round(p2 * 100, 3),
  };
}

/** T-тест Уэлча для средних (выручка, AOV, CPA). */
export function welchTTest(a: number[], b: number[], alpha = 0.05) {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { t: 0, pValue: 1, significant: false, liftPercent: 0 };
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = a.reduce((acc, x) => acc + (x - m1) ** 2, 0) / (n1 - 1);
  const v2 = b.reduce((acc, x) => acc + (x - m2) ** 2, 0) / (n2 - 1);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = se === 0 ? 0 : (m2 - m1) / se;
  const pValue = zToPValue(t);
  return {
    t: round(t, 4),
    pValue,
    significant: pValue < alpha,
    liftPercent: m1 === 0 ? 0 : round(((m2 - m1) / m1) * 100, 2),
  };
}

/**
 * Сколько наблюдений нужно на вариант, чтобы поймать эффект relativeLift
 * при базовой конверсии baselineRate (уровень значимости 0.05, мощность 0.8).
 */
export function sampleSizeForLift(baselineRate: number, relativeLift: number, alpha = 0.05, power = 0.8) {
  const p1 = clamp(baselineRate, 0.0001, 0.9999);
  const p2 = clamp(p1 * (1 + relativeLift), 0.0001, 0.9999);
  const zAlpha = alpha === 0.05 ? 1.96 : alpha === 0.01 ? 2.576 : 1.645;
  const zBeta = power === 0.8 ? 0.8416 : power === 0.9 ? 1.2816 : 0.8416;
  const pBar = (p1 + p2) / 2;
  const numerator = (zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  return Math.ceil(numerator / (p2 - p1) ** 2);
}

/** ICE-скоринг гипотез: 1..5 по каждому критерию → 1..100 */
export function iceScore(x: { expectedEffectPct: number; effort: number; confidence: number }) {
  const impact = clamp(Math.round(Math.log10(Math.max(x.expectedEffectPct, 1)) * 20), 1, 5) || 1;
  const normalizedImpact = clamp(impact, 1, 5);
  const ease = clamp(6 - clamp(x.effort, 1, 5), 1, 5);
  const score = (normalizedImpact * ease * clamp(x.confidence, 1, 5)) / 125 * 100;
  return Math.round(score * 10) / 10;
}

/* ------------------------- строки ------------------------- */

export const slugify = (input: string, translit = true) => {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    ' ': '-', _: '-',
  };
  let out = input.toLowerCase().trim();
  if (translit) out = out.split('').map((ch) => map[ch] ?? ch).join('');
  return out
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export const truncate = (text: string, len: number) => (text.length <= len ? text : `${text.slice(0, len - 1).trimEnd()}…`);

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const maskSecret = (value?: string | null, visible = 4) => {
  if (!value) return null;
  if (value.length <= visible) return '•'.repeat(value.length);
  return `${value.slice(0, visible)}${'•'.repeat(Math.min(12, Math.max(4, value.length - visible)))}`;
};

export const formatBytes = (bytes: number) => {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${round(bytes / 1024 ** i, i === 0 ? 0 : 1)} ${units[i]}`;
};

export const formatMoney = (v: number, currency = '₽') =>
  `${round(v, 0).toLocaleString('ru-RU')} ${currency}`;

export const percentDelta = (current: number, previous: number) =>
  previous === 0 ? (current === 0 ? 0 : 100) : round(((current - previous) / previous) * 100, 1);

/* -------------------- детерминированный ГПСЧ -------------------- */

/** mulberry32 — детерминированный быстрый ГПСЧ (нужен для воспроизводимого демо-режима) */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashCode(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed: string) {
  return mulberry32(hashCode(seed));
}

/** Число из диапазона по детерминированному сеяному ГПСЧ */
export function seededBetween(seed: string, min: number, max: number) {
  const rnd = seededRandom(seed)();
  return round(min + rnd * (max - min), 2);
}

export const nowISO = () => new Date().toISOString();
