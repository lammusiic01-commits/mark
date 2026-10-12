import type { GeoRegion } from '../types.js';

/**
 * Регионы Яндекса (lr). Используется GEO-анализатором, региональной структурой
 * сайта и гео-настройками рекламных кампаний.
 *
 * id — официальный идентификатор региона Яндекса.
 * discountPercent — ориентир по скидке CPC относительно Москвы (для планирования бюджета).
 * demandShare — ориентировочная доля спроса (уточняется Wordstat-данными).
 */

export const REGIONS: GeoRegion[] = [
  { id: 225, name: 'Россия', recommended: true, demandShare: 100 },
  { id: 213, name: 'Москва', cities: ['Москва', 'Зеленоград', 'Химки', 'Балашиха'], discountPercent: 0, demandShare: 30.5, recommended: true },
  { id: 1, name: 'Москва и Московская область', cities: ['Москва', 'Подольск', 'Мытищи', 'Красногорск'], discountPercent: 2, demandShare: 34.2, recommended: true },
  { id: 2, name: 'Санкт-Петербург', cities: ['Санкт-Петербург', 'Пушкин', 'Колпино'], discountPercent: 12, demandShare: 12.4, recommended: true },
  { id: 10174, name: 'Санкт-Петербург и Ленинградская область', cities: ['Санкт-Петербург', 'Гатчина', 'Выборг'], discountPercent: 13, demandShare: 13.9 },
  { id: 65, name: 'Новосибирск', cities: ['Новосибирск', 'Бердск'], discountPercent: 22, demandShare: 3.1, recommended: true },
  { id: 54, name: 'Екатеринбург', cities: ['Екатеринбург', 'Верхняя Пышма', 'Берёзовский'], discountPercent: 20, demandShare: 3.4, recommended: true },
  { id: 43, name: 'Казань', cities: ['Казань', 'Зеленодольск'], discountPercent: 21, demandShare: 2.8, recommended: true },
  { id: 47, name: 'Нижний Новгород', cities: ['Нижний Новгород', 'Дзержинск'], discountPercent: 22, demandShare: 2.3, recommended: true },
  { id: 172, name: 'Уфа', cities: ['Уфа', 'Стерлитамак'], discountPercent: 25, demandShare: 1.8 },
  { id: 56, name: 'Челябинск', cities: ['Челябинск', 'Магнитогорск'], discountPercent: 25, demandShare: 1.7 },
  { id: 51, name: 'Самара', cities: ['Самара', 'Тольятти'], discountPercent: 24, demandShare: 1.7 },
  { id: 66, name: 'Омск', cities: ['Омск'], discountPercent: 27, demandShare: 1.2 },
  { id: 39, name: 'Ростов-на-Дону', cities: ['Ростов-на-Дону', 'Таганрог'], discountPercent: 20, demandShare: 2.4, recommended: true },
  { id: 35, name: 'Краснодар', cities: ['Краснодар', 'Армавир'], discountPercent: 16, demandShare: 2.6, recommended: true },
  { id: 239, name: 'Сочи', cities: ['Сочи', 'Адлер'], discountPercent: 8, demandShare: 1.4 },
  { id: 50, name: 'Пермь', cities: ['Пермь'], discountPercent: 26, demandShare: 1.2 },
  { id: 193, name: 'Воронеж', cities: ['Воронеж'], discountPercent: 23, demandShare: 1.4 },
  { id: 38, name: 'Волгоград', cities: ['Волгоград', 'Волжский'], discountPercent: 27, demandShare: 1.3 },
  { id: 62, name: 'Красноярск', cities: ['Красноярск'], discountPercent: 24, demandShare: 1.2 },
  { id: 63, name: 'Иркутск', cities: ['Иркутск', 'Ангарск'], discountPercent: 26, demandShare: 0.8 },
  { id: 64, name: 'Кемерово', cities: ['Кемерово', 'Новокузнецк'], discountPercent: 30, demandShare: 0.7 },
  { id: 67, name: 'Томск', cities: ['Томск'], discountPercent: 30, demandShare: 0.5 },
  { id: 75, name: 'Владивосток', cities: ['Владивосток', 'Артём'], discountPercent: 22, demandShare: 0.9 },
  { id: 76, name: 'Хабаровск', cities: ['Хабаровск'], discountPercent: 26, demandShare: 0.6 },
  { id: 77, name: 'Благовещенск', cities: ['Благовещенск'], discountPercent: 30, demandShare: 0.3 },
  { id: 197, name: 'Барнаул', cities: ['Барнаул', 'Бийск'], discountPercent: 30, demandShare: 0.6 },
  { id: 973, name: 'Сургут', cities: ['Сургут', 'Нижневартовск'], discountPercent: 15, demandShare: 0.6 },
  { id: 14, name: 'Тверь', cities: ['Тверь'], discountPercent: 30, demandShare: 0.5 },
  { id: 15, name: 'Тула', cities: ['Тула', 'Новомосковск'], discountPercent: 28, demandShare: 0.6 },
  { id: 16, name: 'Ярославль', cities: ['Ярославль', 'Рыбинск'], discountPercent: 28, demandShare: 0.6 },
  { id: 192, name: 'Владимир', cities: ['Владимир', 'Ковров'], discountPercent: 30, demandShare: 0.4 },
  { id: 191, name: 'Брянск', cities: ['Брянск'], discountPercent: 32, demandShare: 0.4 },
  { id: 6, name: 'Калуга', cities: ['Калуга', 'Обнинск'], discountPercent: 28, demandShare: 0.4 },
  { id: 4, name: 'Белгород', cities: ['Белгород', 'Старый Оскол'], discountPercent: 30, demandShare: 0.5 },
  { id: 8, name: 'Курск', cities: ['Курск'], discountPercent: 32, demandShare: 0.4 },
  { id: 9, name: 'Липецк', cities: ['Липецк'], discountPercent: 32, demandShare: 0.3 },
  { id: 13, name: 'Тамбов', cities: ['Тамбов'], discountPercent: 34, demandShare: 0.2 },
  { id: 11, name: 'Рязань', cities: ['Рязань'], discountPercent: 30, demandShare: 0.4 },
  { id: 12, name: 'Смоленск', cities: ['Смоленск'], discountPercent: 32, demandShare: 0.3 },
  { id: 22, name: 'Калининград', cities: ['Калининград'], discountPercent: 20, demandShare: 0.7 },
  { id: 23, name: 'Мурманск', cities: ['Мурманск'], discountPercent: 26, demandShare: 0.3 },
  { id: 20, name: 'Архангельск', cities: ['Архангельск', 'Северодвинск'], discountPercent: 30, demandShare: 0.3 },
  { id: 21, name: 'Вологда', cities: ['Вологда', 'Череповец'], discountPercent: 30, demandShare: 0.3 },
  { id: 24, name: 'Великий Новгород', cities: ['Великий Новгород'], discountPercent: 30, demandShare: 0.2 },
  { id: 25, name: 'Псков', cities: ['Псков'], discountPercent: 32, demandShare: 0.2 },
  { id: 37, name: 'Астрахань', cities: ['Астрахань'], discountPercent: 30, demandShare: 0.3 },
  { id: 36, name: 'Ставрополь', cities: ['Ставрополь', 'Пятигорск', 'Кисловодск'], discountPercent: 26, demandShare: 0.8 },
  { id: 1092, name: 'Назрань', cities: ['Назрань'], discountPercent: 35, demandShare: 0.2 },
  { id: 28, name: 'Махачкала', cities: ['Махачкала', 'Дербент'], discountPercent: 34, demandShare: 0.5 },
  { id: 30, name: 'Нальчик', cities: ['Нальчик'], discountPercent: 34, demandShare: 0.2 },
  { id: 33, name: 'Владикавказ', cities: ['Владикавказ'], discountPercent: 34, demandShare: 0.2 },
  { id: 1106, name: 'Грозный', cities: ['Грозный'], discountPercent: 35, demandShare: 0.2 },
  { id: 45, name: 'Чебоксары', cities: ['Чебоксары', 'Новочебоксарск'], discountPercent: 30, demandShare: 0.4 },
  { id: 42, name: 'Саранск', cities: ['Саранск'], discountPercent: 32, demandShare: 0.2 },
  { id: 41, name: 'Йошкар-Ола', cities: ['Йошкар-Ола'], discountPercent: 32, demandShare: 0.2 },
  { id: 48, name: 'Оренбург', cities: ['Оренбург', 'Орск'], discountPercent: 30, demandShare: 0.4 },
  { id: 49, name: 'Пенза', cities: ['Пенза'], discountPercent: 30, demandShare: 0.3 },
  { id: 53, name: 'Курган', cities: ['Курган'], discountPercent: 34, demandShare: 0.2 },
  { id: 149, name: 'Беларусь', cities: ['Минск', 'Гомель', 'Брест'], discountPercent: 25, demandShare: 1.6 },
  { id: 159, name: 'Казахстан', cities: ['Алматы', 'Астана', 'Шымкент'], discountPercent: 18, demandShare: 1.9 },
  { id: 187, name: 'Украина', cities: ['Киев', 'Харьков', 'Одесса'], discountPercent: 30, demandShare: 0.8 },
  { id: 171, name: 'Узбекистан', cities: ['Ташкент', 'Самарканд'], discountPercent: 32, demandShare: 0.5 },
  { id: 0, name: 'Весь мир', recommended: true, demandShare: 100 },
];

/** Округа и укрупнённые регионы Яндекса (для быстрого выбора). */
export const REGION_GROUPS: { id: number; name: string; regionIds: number[] }[] = [
  { id: 225, name: 'Россия', regionIds: [213, 1, 2, 65, 54, 43, 47, 172, 56, 51, 66, 39, 35, 239, 50, 193, 38, 62, 63, 75] },
  { id: 3, name: 'Центральный ФО', regionIds: [213, 1, 14, 15, 16, 192, 191, 4, 8, 9, 13, 11, 12] },
  { id: 17, name: 'Северо-Западный ФО', regionIds: [2, 10174, 22, 23, 20, 21, 24, 25] },
  { id: 40, name: 'Южный ФО', regionIds: [39, 35, 239, 193, 38, 37] },
  { id: 26, name: 'Северо-Кавказский ФО', regionIds: [36, 1092, 28, 30, 33, 1106] },
  { id: 52, name: 'Приволжский ФО', regionIds: [47, 43, 172, 51, 50, 45, 42, 41, 48, 49] },
  { id: 58, name: 'Уральский ФО', regionIds: [54, 56, 53, 973] },
  { id: 59, name: 'Сибирский ФО', regionIds: [65, 62, 63, 64, 67, 197, 66] },
  { id: 73, name: 'Дальневосточный ФО', regionIds: [75, 76, 77] },
];

export const REGION_MAP: Record<number, GeoRegion> = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

export const regionName = (id: number) => REGION_MAP[id]?.name ?? `Регион ${id}`;

/** Средняя скидка CPC по РФ относительно Москвы (для Market Analyzer). */
export const MOSCOW_CPC_INDEX = 1;

export function cpcMultiplierForRegion(regionId: number): number {
  const region = REGION_MAP[regionId];
  const discount = region?.discountPercent ?? 22;
  return Number((1 - discount / 100).toFixed(3));
}
