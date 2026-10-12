import { hashCode, mulberry32, round } from '../utils.js';

/**
 * Отраслевые бенчмарки CPC/CTR для Market Analyzer.
 *
 * Значения — ориентиры по российскому рынку (Яндекс.Директ, поиск), собранные
 * из открытых отчётов и практики агентств. Используются как «эталон ниши»,
 * с которым сравнивается фактический CPC клиента.
 *
 * Мultipliers: по региону (см. regions.ts) и по типу ключа (коммерческий брендовый и т.д.).
 */

export interface NicheBenchmark {
  id: string;
  name: string;
  /** Медианный CPC в Москве, ₽ */
  cpcMoscow: number;
  /** CTR в поиске, % */
  ctr: number;
  /** Конверсия сайта в лид/заказ, % */
  conversion: number;
  /** Конкуренция */
  competition: 'low' | 'medium' | 'high' | 'very_high';
  /** Типичная сезонность (множитель по месяцам, 1 = среднемесячный уровень) */
  seasonality: number[];
  /** Средний чек/ценность лида, ₽ */
  averageOrderValue: number;
  competitors: { name: string; domain: string; note: string }[];
  keywords: string[];
}

const SEASON_FLAT = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

export const NICHES: NicheBenchmark[] = [
  {
    id: 'repair-apartment',
    name: 'Ремонт квартир',
    cpcMoscow: 118,
    ctr: 4.8,
    conversion: 6.5,
    competition: 'high',
    seasonality: [0.7, 0.75, 0.9, 1.05, 1.2, 1.25, 1.2, 1.25, 1.3, 1.2, 0.95, 0.8],
    averageOrderValue: 380000,
    competitors: [
      { name: 'Мосремонт', domain: 'mosremont-example.ru', note: 'Сильная семантика + квиз-калькулятор' },
      { name: 'ГК Ремонт-Строй', domain: 'remontstroy-example.ru', note: 'Агрессивные ставки по брендовым конкурентам' },
      { name: 'Леруа-партнёры', domain: 'partner-example.ru', note: 'Медийные кампании + РСЯ' },
    ],
    keywords: ['ремонт квартир', 'ремонт квартир под ключ', 'отделка квартиры', 'ремонт новостройки', 'дизайнерский ремонт'],
  },
  {
    id: 'stomatology',
    name: 'Стоматология',
    cpcMoscow: 162,
    ctr: 5.6,
    conversion: 9.2,
    competition: 'very_high',
    seasonality: [1.1, 1.15, 1.1, 1, 0.95, 0.85, 0.85, 0.9, 1.1, 1.15, 1, 0.95],
    averageOrderValue: 24500,
    competitors: [
      { name: 'Стоматология №1', domain: 'stom1-example.ru', note: 'Имплантация, высокий бюджет' },
      { name: 'Дентал Клиник', domain: 'dental-example.ru', note: 'Сильный GEO и карточки' },
    ],
    keywords: ['имплантация зубов', 'стоматология рядом', 'брекеты цена', 'лечение зубов', 'виниры'],
  },
  {
    id: 'auto-service',
    name: 'Автосервис',
    cpcMoscow: 86,
    ctr: 5.1,
    conversion: 11,
    competition: 'high',
    seasonality: [1.2, 1.15, 1.1, 1.05, 1, 0.95, 0.85, 0.85, 1, 1.1, 1.1, 1.15],
    averageOrderValue: 18500,
    competitors: [
      { name: 'АвтоТехЦентр', domain: 'autotech-example.ru', note: 'Карточки в Яндекс.Бизнес, много отзывов' },
      { name: 'Кузовной доктор', domain: 'kuzov-example.ru', note: 'Ставки по «малярка/покраска»' },
    ],
    keywords: ['автосервис', 'ремонт двигателя', 'замена масла цена', 'кузовной ремонт', 'компьютерная диагностика'],
  },
  {
    id: 'legal',
    name: 'Юридические услуги',
    cpcMoscow: 143,
    ctr: 5.3,
    conversion: 7.4,
    competition: 'high',
    seasonality: SEASON_FLAT,
    averageOrderValue: 42000,
    competitors: [
      { name: 'Юрбюро Итог', domain: 'uritog-example.ru', note: 'Захват брендов конкурентов' },
      { name: 'Правовой центр', domain: 'pravcentr-example.ru', note: 'Много лендингов по каждой услуге' },
    ],
    keywords: ['юрист консультация', 'взыскание долгов', 'банкротство физических лиц', 'семейный юрист', 'арбитражный юрист'],
  },
  {
    id: 'real-estate',
    name: 'Недвижимость',
    cpcMoscow: 232,
    ctr: 4.2,
    conversion: 4.1,
    competition: 'very_high',
    seasonality: [0.85, 0.9, 1.05, 1.15, 1.1, 1, 0.9, 1, 1.15, 1.2, 1, 0.85],
    averageOrderValue: 3800000,
    competitors: [
      { name: 'Агентство Недра', domain: 'nedra-example.ru', note: 'Динамический ретаргетинг + РСЯ' },
      { name: 'Новостройки Центр', domain: 'novostroy-example.ru', note: 'Работа с застройщиками, CPL-модель' },
    ],
    keywords: ['квартира в новостройке', 'купить квартиру', 'агентство недвижимости', 'вторичка', 'ипотека с господдержкой'],
  },
  {
    id: 'ecommerce-clothes',
    name: 'Интернет-магазин одежды',
    cpcMoscow: 32,
    ctr: 3.4,
    conversion: 2.1,
    competition: 'very_high',
    seasonality: [1.2, 1.15, 1.1, 1, 0.95, 0.85, 0.85, 1, 1.15, 1.1, 1.25, 1.35],
    averageOrderValue: 4600,
    competitors: [
      { name: 'Fashion Store', domain: 'fashion-example.ru', note: 'Товарные кампании, фиды' },
      { name: 'Одежда Маркет', domain: 'odezhda-example.ru', note: 'Скидочные акции круглый год' },
    ],
    keywords: ['купить платье', 'куртка женская', 'кроссовки мужские', 'интернет-магазин одежды', 'джинсы'],
  },
  {
    id: 'food-delivery',
    name: 'Доставка еды',
    cpcMoscow: 41,
    ctr: 4.9,
    conversion: 5.8,
    competition: 'very_high',
    seasonality: [1.05, 1, 1, 1, 1, 0.95, 0.9, 0.95, 1.05, 1.1, 1.05, 1.15],
    averageOrderValue: 1750,
    competitors: [
      { name: 'Вкусно-Тут', domain: 'vkusno-example.ru', note: 'Гео-кампании по районам' },
      { name: 'Суши Мастер', domain: 'sushi-example.ru', note: 'РСЯ-медиа + промокоды' },
    ],
    keywords: ['доставка еды', 'заказать суши', 'пицца на дом', 'доставка обедов', 'роллы'],
  },
  {
    id: 'online-courses',
    name: 'Онлайн-курсы и образование',
    cpcMoscow: 74,
    ctr: 4.4,
    conversion: 3.2,
    competition: 'high',
    seasonality: [1.25, 1.15, 1.05, 0.95, 0.9, 0.85, 0.9, 1, 1.15, 1.1, 1.05, 1.1],
    averageOrderValue: 32000,
    competitors: [
      { name: 'SkillHub', domain: 'skillhub-example.ru', note: 'Вебинары, лид-магниты' },
      { name: 'Academy Pro', domain: 'academy-example.ru', note: 'Агрессивный ретаргетинг' },
    ],
    keywords: ['курсы python', 'обучение маркетингу', 'онлайн-школа', 'курсы дизайна', 'повышение квалификации'],
  },
  {
    id: 'b2b-saas',
    name: 'B2B SaaS / ПО',
    cpcMoscow: 128,
    ctr: 4.6,
    conversion: 2.4,
    competition: 'medium',
    seasonality: SEASON_FLAT,
    averageOrderValue: 145000,
    competitors: [
      { name: 'CRM Платформа', domain: 'crm-example.ru', note: 'Контент-маркетинг + демо-запросы' },
      { name: 'ERP Система', domain: 'erp-example.ru', note: 'Узкие сегментные лендинги' },
    ],
    keywords: ['crm система', 'программа для склада', 'учёт в торговле', 'автоматизация продаж', 'saas для бизнеса'],
  },
  {
    id: 'cleaning',
    name: 'Клининг',
    cpcMoscow: 63,
    ctr: 5.8,
    conversion: 8.6,
    competition: 'medium',
    seasonality: [0.9, 0.95, 1.1, 1.2, 1.15, 1.05, 1, 1.05, 1.1, 1.1, 0.95, 0.95],
    averageOrderValue: 5400,
    competitors: [
      { name: 'Чисто Про', domain: 'chisto-example.ru', note: 'Яндекс.Бизнес и отзывы' },
      { name: 'Клининг Сервис', domain: 'klining-example.ru', note: 'Пакеты услуг в объявлениях' },
    ],
    keywords: ['клининг', 'уборка квартир', 'химчистка мебели', 'уборка офиса', 'генеральная уборка'],
  },
  {
    id: 'tourism',
    name: 'Туризм и экскурсии',
    cpcMoscow: 97,
    ctr: 4.7,
    conversion: 4.6,
    competition: 'high',
    seasonality: [0.8, 0.85, 1, 1.15, 1.3, 1.35, 1.3, 1.2, 1.05, 0.95, 0.85, 0.9],
    averageOrderValue: 46000,
    competitors: [
      { name: 'Тур-Мастер', domain: 'turmaster-example.ru', note: 'Медийка + поиск по направлениям' },
      { name: 'Экскурсии Города', domain: 'ekskurs-example.ru', note: 'Локальные гео-кампании' },
    ],
    keywords: ['туры в турцию', 'экскурсии по городу', 'отдых в сочи', 'горящие туры', 'круизы'],
  },
  {
    id: 'fitness',
    name: 'Фитнес и спорт',
    cpcMoscow: 68,
    ctr: 5.2,
    conversion: 6.8,
    competition: 'medium',
    seasonality: [1.45, 1.3, 1.15, 1.05, 0.95, 0.85, 0.8, 0.9, 1.15, 1.1, 0.95, 1.1],
    averageOrderValue: 26000,
    competitors: [
      { name: 'Фитнес Парк', domain: 'fitness-example.ru', note: 'Пробные занятия как лид-магнит' },
      { name: 'Спорт-Клуб', domain: 'sportklub-example.ru', note: 'Годовые карты с рассрочкой' },
    ],
    keywords: ['фитнес рядом', 'тренажёрный зал', 'абонемент в фитнес', 'персональный тренер', 'бассейн'],
  },
  {
    id: 'beauty',
    name: 'Салоны красоты',
    cpcMoscow: 54,
    ctr: 6.1,
    conversion: 10.4,
    competition: 'medium',
    seasonality: [1.1, 1.15, 1.15, 1.05, 1.05, 0.95, 0.85, 0.9, 1.05, 1.1, 1.1, 1.25],
    averageOrderValue: 6800,
    competitors: [
      { name: 'Beauty Room', domain: 'beauty-example.ru', note: 'Онлайн-запись + карточки' },
      { name: 'Студия Ресниц', domain: 'lashi-example.ru', note: 'Узкая ниша, дешёвые лиды' },
    ],
    keywords: ['салон красоты', 'наращивание ресниц', 'маникюр цена', 'стрижка женская', 'косметолог'],
  },
  {
    id: 'metalworking',
    name: 'Металлообработка / производство',
    cpcMoscow: 91,
    ctr: 3.8,
    conversion: 3.1,
    competition: 'low',
    seasonality: [0.9, 1, 1.1, 1.1, 1.05, 1, 0.9, 0.9, 1.1, 1.1, 1, 0.95],
    averageOrderValue: 320000,
    competitors: [
      { name: 'МеталлПром', domain: 'metallprom-example.ru', note: 'Лендинги под каждый вид обработки' },
      { name: 'Лазер-Резка', domain: 'lazerra-example.ru', note: 'Расчёт онлайн в объявлении' },
    ],
    keywords: ['металлообработка', 'лазерная резка металла', 'токарные работы', 'фрезеровка чпу', 'сварные конструкции'],
  },
  {
    id: 'logistics',
    name: 'Грузоперевозки / логистика',
    cpcMoscow: 89,
    ctr: 4.9,
    conversion: 7.2,
    competition: 'high',
    seasonality: [0.95, 1, 1.05, 1.05, 1.05, 1, 1, 1.05, 1.1, 1.1, 1, 0.95],
    averageOrderValue: 24000,
    competitors: [
      { name: 'ТрансЛайн', domain: 'translain-example.ru', note: 'Калькулятор + быстрая заявка' },
      { name: 'Газель-Сервис', domain: 'gazel-example.ru', note: 'Локальные гео-кампании' },
    ],
    keywords: ['грузоперевозки', 'переезд квартиры', 'газель с грузчиками', 'междугородние перевозки', 'вывоз мусора'],
  },
  {
    id: 'insurance',
    name: 'Страхование',
    cpcMoscow: 156,
    ctr: 4.1,
    conversion: 3.6,
    competition: 'high',
    seasonality: [0.95, 1, 1.05, 1.1, 1.1, 1.05, 1.1, 1.05, 1.05, 1, 0.95, 0.9],
    averageOrderValue: 18500,
    competitors: [
      { name: 'Страх-Плюс', domain: 'strahplus-example.ru', note: 'Онлайн-расчёт и покупка на сайте' },
      { name: 'АвтоСтрах', domain: 'avtostrah-example.ru', note: 'Гео-кампании по ОСАГО' },
    ],
    keywords: ['осаго онлайн', 'каско расчёт', 'страхование квартиры', 'дмс для сотрудников', 'страховка ипотеки'],
  },
  {
    id: 'hr-recruiting',
    name: 'HR / подбор персонала',
    cpcMoscow: 82,
    ctr: 4.9,
    conversion: 5.4,
    competition: 'medium',
    seasonality: [1.2, 1.15, 1.1, 1, 1, 0.9, 0.85, 0.9, 1.15, 1.1, 1, 0.95],
    averageOrderValue: 68000,
    competitors: [
      { name: 'Кадровое Агентство', domain: 'kadry-example.ru', note: 'Отраслевые лендинги' },
      { name: 'Персонал-Про', domain: 'personal-example.ru', note: 'Работа с крупными B2B' },
    ],
    keywords: ['подбор персонала', 'аутсорсинг персонала', 'кадровое агентство', 'поиск сотрудников', 'лизинг персонала'],
  },
  {
    id: 'digital-agency',
    name: 'Digital-агентство',
    cpcMoscow: 112,
    ctr: 4.3,
    conversion: 4.8,
    competition: 'high',
    seasonality: [0.9, 1, 1.1, 1.1, 1.05, 1, 0.9, 0.95, 1.15, 1.15, 1.05, 0.85],
    averageOrderValue: 185000,
    competitors: [
      { name: 'Performance Lab', domain: 'perflab-example.ru', note: 'Кейсы и калькулятор бюджета' },
      { name: 'SEO Студия', domain: 'seostudio-example.ru', note: 'Контент + бесплатный аудит' },
    ],
    keywords: ['seo продвижение сайта', 'настройка яндекс директа', 'digital агентство', 'контекстная реклама', 'продвижение в интернете'],
  },
];

export const NICHE_MAP: Record<string, NicheBenchmark> = Object.fromEntries(NICHES.map((n) => [n.id, n]));

/** Определение ниши по тексту запроса/описанию проекта (простой и предсказуемый матчер). */
export function detectNiche(input: string): NicheBenchmark {
  const text = input.toLowerCase();
  let best: { niche: NicheBenchmark; score: number } | null = null;
  for (const niche of NICHES) {
    let score = 0;
    if (text.includes(niche.name.toLowerCase())) score += 10;
    if (text.includes(niche.id)) score += 8;
    for (const kw of niche.keywords) {
      const stem = kw.toLowerCase().slice(0, Math.max(4, Math.floor(kw.length * 0.6)));
      if (text.includes(stem)) score += 3;
      const firstWord = kw.toLowerCase().split(' ')[0];
      if (firstWord.length > 3 && text.includes(firstWord)) score += 1;
    }
    if (!best || score > best.score) best = { niche, score };
  }
  return best && best.score > 0 ? best.niche : NICHE_MAP['digital-agency'];
}

/** Множители CPC по типу ключевой фразы. */
export const KEYWORD_INTENT_MULTIPLIERS: { id: string; label: string; multiplier: number; pattern: RegExp }[] = [
  { id: 'brand', label: 'Брендовый запрос', multiplier: 0.45, pattern: /(?:^|\s)(?:бренд|официальный сайт|личный кабинет)(?:\s|$)/i },
  { id: 'geo', label: 'Гео-запрос «рядом»', multiplier: 0.8, pattern: /(?:рядом|около меня|поблизости|в москве|в спб|в санкт-петербурге)/i },
  { id: 'price', label: 'Ценовой запрос', multiplier: 1.05, pattern: /(цена|стоимость|сколько стоит|прайс|недорого)/i },
  { id: 'buy', label: 'Транзакционный', multiplier: 1.25, pattern: /(купить|заказать|заявка|оставить|записаться|онлайн)/i },
  { id: 'info', label: 'Информационный', multiplier: 0.6, pattern: /(как |что такое|почему|инструкция|своими руками|отзывы)/i },
];

export function keywordMultiplier(keyword: string): { multiplier: number; intent: string } {
  for (const intent of KEYWORD_INTENT_MULTIPLIERS) {
    if (intent.pattern.test(keyword)) return { multiplier: intent.multiplier, intent: intent.label };
  }
  return { multiplier: 1, intent: 'Коммерческий (общий)' };
}

/** Сезонный множитель спроса по нише и месяцу (0..11). */
export function seasonalMultiplier(nicheId: string, monthIndex: number): number {
  const niche = NICHE_MAP[nicheId];
  if (!niche) return 1;
  return niche.seasonality[monthIndex] ?? 1;
}

/** Детерминированная генерация «частотности» ключа для демо-режима. */
export function syntheticFrequency(keyword: string, base = 4200): number {
  const rnd = mulberry32(hashCode(`freq:${keyword}`));
  const words = keyword.split(/\s+/).length;
  const factor = words === 1 ? 1.9 : words === 2 ? 1.3 : words === 3 ? 0.9 : 0.55;
  const noise = 0.55 + rnd() * 0.9;
  return Math.max(35, Math.round(base * factor * noise));
}

/** Детерминированный CPC для демо-режима на основе бенчмарка ниши. */
export function syntheticCpc(niche: NicheBenchmark, keyword: string, regionMultiplier: number) {
  const { multiplier } = keywordMultiplier(keyword);
  const rnd = mulberry32(hashCode(`cpc:${niche.id}:${keyword}`));
  const noise = 0.82 + rnd() * 0.45;
  return round(niche.cpcMoscow * regionMultiplier * multiplier * noise, 2);
}
