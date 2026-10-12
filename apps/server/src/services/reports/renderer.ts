import fs from 'node:fs';
import path from 'node:path';
import type { ReportRecord, ReportSection } from '@mark/shared';
import { config } from '../../config.js';
import { rootLogger } from '../../logger.js';

/**
 * Рендер отчётов: печатный HTML (готов к «Сохранить как PDF»),
 * генерация PDF через Chromium (playwright-core / Electron) и выгрузка данных.
 *
 * Графики рисуются встроенным генератором SVG — без внешних зависимостей,
 * они корректно печатаются и не требуют JavaScript при открытии PDF.
 */

const log = rootLogger.child('report-render');

/* ------------------------------ SVG-графики ------------------------------ */

const PALETTE = ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];

const escapeXml = (value: string | number) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svgLineChart(section: NonNullable<ReportSection['chart']>, width = 720, height = 280): string {
  const padding = { top: 24, right: 16, bottom: 44, left: 56 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const allValues = section.series.flatMap((serie) => serie.data);
  const max = Math.max(1, ...allValues);
  const categories = section.categories;
  const stepX = categories.length > 1 ? innerWidth / (categories.length - 1) : 0;

  const y = (value: number) => padding.top + innerHeight - (value / max) * innerHeight;
  const x = (index: number) => padding.left + index * stepX;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const value = max * ratio;
      return `<line x1="${padding.left}" y1="${y(value)}" x2="${width - padding.right}" y2="${y(value)}" stroke="#e5e7eb" stroke-width="1"/>
        <text x="${padding.left - 8}" y="${y(value) + 4}" text-anchor="end" font-size="10" fill="#6b7280">${escapeXml(Math.round(value).toLocaleString('ru-RU'))}</text>`;
    })
    .join('');

  const labelStep = Math.max(1, Math.ceil(categories.length / 8));
  const labels = categories
    .map((category, index) =>
      index % labelStep === 0
        ? `<text x="${x(index)}" y="${height - 16}" text-anchor="middle" font-size="10" fill="#6b7280">${escapeXml(category)}</text>`
        : '',
    )
    .join('');

  const paths = section.series
    .map((serie, serieIndex) => {
      const color = PALETTE[serieIndex % PALETTE.length];
      const points = serie.data.map((value, index) => `${x(index)},${y(value)}`).join(' ');
      const polyline = serie.data.length > 2 ? `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>` : '';
      const dots = serie.data.map((value, index) => `<circle cx="${x(index)}" cy="${y(value)}" r="2.6" fill="${color}"/>`).join('');
      const legend = `<rect x="${padding.left + serieIndex * 150}" y="6" width="10" height="10" fill="${color}"/><text x="${padding.left + serieIndex * 150 + 15}" y="15" font-size="10" fill="#374151">${escapeXml(serie.name)}</text>`;
      return `${polyline}${dots}${legend}`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeXml(section.title)}">
    ${gridLines}${paths}${labels}
  </svg>`;
}

function svgBarChart(section: NonNullable<ReportSection['chart']>, width = 720, height = 280): string {
  const padding = { top: 26, right: 16, bottom: 52, left: 56 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const allValues = section.series.flatMap((serie) => serie.data);
  const max = Math.max(1, ...allValues);
  const groups = section.categories.length || 1;
  const groupWidth = innerWidth / groups;
  const barWidth = Math.min(38, (groupWidth * 0.7) / section.series.length);

  const gridLines = [0, 0.5, 1]
    .map((ratio) => {
      const value = max * ratio;
      const y = padding.top + innerHeight - ratio * innerHeight;
      return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e5e7eb"/>
        <text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#6b7280">${escapeXml(Math.round(value).toLocaleString('ru-RU'))}</text>`;
    })
    .join('');

  const bars = section.categories
    .map((category, groupIndex) => {
      const groupX = padding.left + groupIndex * groupWidth + groupWidth / 2;
      const barsForGroup = section.series
        .map((serie, serieIndex) => {
          const value = serie.data[groupIndex] ?? 0;
          const barHeight = (value / max) * innerHeight;
          const barX = groupX - (barWidth * section.series.length) / 2 + serieIndex * barWidth;
          return `<rect x="${barX}" y="${padding.top + innerHeight - barHeight}" width="${barWidth - 2}" height="${Math.max(1, barHeight)}" fill="${PALETTE[serieIndex % PALETTE.length]}" rx="3"/>`;
        })
        .join('');
      const label = `<text x="${groupX}" y="${height - 26}" text-anchor="middle" font-size="9" fill="#6b7280">${escapeXml(category.slice(0, 14))}</text>`;
      return `${barsForGroup}${label}`;
    })
    .join('');

  const legend = section.series
    .map(
      (serie, index) =>
        `<rect x="${padding.left + index * 150}" y="8" width="10" height="10" fill="${PALETTE[index % PALETTE.length]}"/><text x="${padding.left + index * 150 + 15}" y="17" font-size="10" fill="#374151">${escapeXml(serie.name)}</text>`,
    )
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeXml(section.title)}">${gridLines}${bars}${legend}</svg>`;
}

function svgPieChart(section: NonNullable<ReportSection['chart']>, width = 420, height = 260): string {
  const data = section.series[0]?.data ?? [];
  const total = data.reduce((acc, value) => acc + Math.max(0, value), 0) || 1;
  const cx = height / 2;
  const cy = height / 2;
  const radius = height / 2 - 20;
  let angle = -Math.PI / 2;

  const slices = data
    .map((value, index) => {
      const share = Math.max(0, value) / total;
      const sweep = share * Math.PI * 2;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(angle + sweep);
      const y2 = cy + radius * Math.sin(angle + sweep);
      const largeArc = sweep > Math.PI ? 1 : 0;
      const color = PALETTE[index % PALETTE.length];
      const pathData =
        share >= 0.999
          ? `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`
          : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
      angle += sweep;
      const labelX = cx + radius * 0.62 * Math.cos(angle - sweep / 2);
      const labelY = cy + radius * 0.62 * Math.sin(angle - sweep / 2);
      const label = share > 0.06 ? `<text x="${labelX}" y="${labelY + 3}" text-anchor="middle" font-size="11" fill="#ffffff" font-weight="600">${Math.round(share * 100)}%</text>` : '';
      return `<path d="${pathData}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>${label}`;
    })
    .join('');

  const legend = section.categories
    .map(
      (category, index) =>
        `<rect x="${height + 12}" y="${20 + index * 20}" width="10" height="10" fill="${PALETTE[index % PALETTE.length]}"/><text x="${height + 28}" y="${29 + index * 20}" font-size="11" fill="#374151">${escapeXml(category)} — ${escapeXml(data[index] ?? 0)}</text>`,
    )
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeXml(section.title)}">${slices}${legend}</svg>`;
}

export function renderChart(section: ReportSection): string {
  if (!section.chart) return '';
  const chart = section.chart;
  if (!chart.categories.length || !chart.series.length) return '';
  if (chart.type === 'pie') return svgPieChart(chart);
  if (chart.type === 'bar') return svgBarChart(chart);
  return svgLineChart(chart);
}

/* ------------------------------- HTML-шаблон ------------------------------- */

export function renderReportHtml(report: ReportRecord, options: { forPrint?: boolean } = {}): string {
  const brand = report.branding;
  const kpis = report.kpis
    .map(
      (kpi) => `<div class="kpi">
        <div class="kpi-label">${escapeXml(kpi.label)}</div>
        <div class="kpi-value">${escapeXml(kpi.value)}</div>
        ${kpi.delta !== undefined ? `<div class="kpi-delta ${kpi.delta >= 0 ? 'up' : 'down'}">${kpi.delta >= 0 ? '▲' : '▼'} ${Math.abs(kpi.delta)}% к прошлому периоду</div>` : ''}
        ${kpi.hint ? `<div class="kpi-hint">${escapeXml(kpi.hint)}</div>` : ''}
      </div>`,
    )
    .join('');

  const sections = report.sections
    .map(
      (section) => `<section class="block">
      <h2>${escapeXml(section.title)}</h2>
      ${section.kpis?.length ? `<div class="kpis">${section.kpis.map((kpi) => `<div class="kpi small"><div class="kpi-label">${escapeXml(kpi.label)}</div><div class="kpi-value">${escapeXml(kpi.value)}</div></div>`).join('')}</div>` : ''}
      ${section.paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('')}
      ${section.bullets.length ? `<ul>${section.bullets.map((bullet) => `<li>${escapeXml(bullet)}</li>`).join('')}</ul>` : ''}
      ${
        section.table
          ? `<table><thead><tr>${section.table.columns.map((column) => `<th>${escapeXml(column)}</th>`).join('')}</tr></thead>
        <tbody>${section.table.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${escapeXml(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
          : ''
      }
      ${section.chart ? `<div class="chart"><div class="chart-title">${escapeXml(section.chart.title)}</div>${renderChart(section)}</div>` : ''}
    </section>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(report.title)}</title>
<style>
  :root { --brand: ${brand.brandColor}; --accent: ${brand.accentColor}; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #f3f4f6; color: #111827; font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .page { max-width: 960px; margin: 0 auto; background: #ffffff; padding: 40px 44px 56px; }
  header { border-bottom: 3px solid var(--brand); padding-bottom: 18px; margin-bottom: 24px; display: flex; align-items: center; gap: 16px; }
  header img { max-height: 54px; max-width: 200px; }
  .brand-name { font-size: 20px; font-weight: 700; color: var(--brand); }
  .meta { color: #6b7280; font-size: 12px; margin-top: 4px; }
  h1 { font-size: 24px; margin: 12px 0 6px; }
  h2 { font-size: 17px; margin: 26px 0 10px; color: var(--brand); }
  p { margin: 8px 0; }
  ul { margin: 8px 0 8px 18px; padding: 0; }
  li { margin: 4px 0; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0 24px; }
  .kpi { border: 1px solid #e5e7eb; border-left: 4px solid var(--accent); border-radius: 8px; padding: 10px 12px; background: #fafafa; }
  .kpi.small { border-left-color: var(--brand); }
  .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; }
  .kpi-value { font-size: 19px; font-weight: 700; margin-top: 4px; }
  .kpi-delta { font-size: 11px; margin-top: 4px; }
  .kpi-delta.up { color: #059669; }
  .kpi-delta.down { color: #dc2626; }
  .kpi-hint { font-size: 11px; color: #6b7280; margin-top: 2px; }
  .block { margin-bottom: 26px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 12.5px; }
  th, td { border: 1px solid #e5e7eb; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-weight: 600; }
  tr:nth-child(even) td { background: #fcfcfd; }
  .chart { margin: 16px 0; page-break-inside: avoid; }
  .chart-title { font-size: 12px; color: #6b7280; margin-bottom: 6px; }
  footer { margin-top: 32px; border-top: 1px solid #e5e7eb; padding-top: 14px; color: #6b7280; font-size: 12px; display: flex; justify-content: space-between; gap: 16px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--brand); color: #fff; font-size: 11px; }
  @media print {
    body { background: #fff; }
    .page { padding: 0; max-width: none; }
    .block { page-break-inside: avoid; }
    h2 { page-break-after: avoid; }
    ${options.forPrint ? '' : ''}
  }
</style>
</head>
<body>
<div class="page">
  <header>
    ${brand.logoDataUrl ? `<img src="${brand.logoDataUrl}" alt="${escapeXml(brand.agencyName)}">` : ''}
    <div>
      <div class="brand-name">${escapeXml(brand.agencyName)}</div>
      <div class="meta">Отчёт подготовлен платформой MARK${brand.hideMarkBranding ? '' : ' · mark.platform'}</div>
    </div>
  </header>

  <h1>${escapeXml(report.title)}</h1>
  <div class="meta">Период: ${escapeXml(report.periodFrom)} — ${escapeXml(report.periodTo)} · Сформирован: ${escapeXml(new Date(report.generatedAt ?? report.createdAt).toLocaleString('ru-RU'))} · <span class="badge">${escapeXml(report.type)}</span></div>

  ${kpis ? `<div class="kpis">${kpis}</div>` : ''}
  ${sections}

  <footer>
    <div>${escapeXml(brand.footerNote ?? `${brand.agencyName} — отчёт сформирован автоматически`)}</div>
    <div>${brand.hideMarkBranding ? '' : 'MARK Platform'}</div>
  </footer>
</div>
</body>
</html>`;
}

/* ------------------------------ Сохранение / PDF ------------------------------ */

export function saveReportHtml(report: ReportRecord): { filePath: string; sizeBytes: number } {
  const dir = config.reportsDir;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${report.id}.html`);
  const html = renderReportHtml(report, { forPrint: true });
  fs.writeFileSync(filePath, html, 'utf8');
  return { filePath, sizeBytes: Buffer.byteLength(html, 'utf8') };
}

/** CSV-выгрузка таблиц отчёта (для Excel) — всегда доступна, без зависимостей. */
export function renderReportCsv(report: ReportRecord): string {
  const lines: string[] = [`Отчёт;${report.title}`, `Период;${report.periodFrom};${report.periodTo}`, ''];
  for (const section of report.sections) {
    lines.push(`# ${section.title}`);
    for (const paragraph of section.paragraphs) lines.push(paragraph.replace(/;/g, ','));
    if (section.table) {
      lines.push(section.table.columns.join(';'));
      for (const row of section.table.rows) lines.push(row.map((cell) => String(cell).replace(/;/g, ',')).join(';'));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * PDF-рендер. Использует Chromium (playwright-core) или Electron-печать.
 * Если движок недоступен — возвращает null, и вызывающий код отдаёт печатный HTML
 * (браузер откроет его и предложит «Сохранить как PDF» — результат идентичен).
 */
export async function renderReportPdf(report: ReportRecord): Promise<Buffer | null> {
  const html = renderReportHtml(report, { forPrint: true });
  try {
    const { chromium } = await import('playwright-core');
    for (const channel of ['chrome', 'msedge', undefined] as const) {
      try {
        const browser = await chromium.launch({ channel: channel as 'chrome' | 'msedge' | undefined, headless: true });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' } });
        await browser.close();
        log.info(`PDF отчёта ${report.id} сформирован (${(pdf.length / 1024).toFixed(0)} КБ)`);
        return Buffer.from(pdf);
      } catch (error) {
        log.debug(`PDF-движок ${channel ?? 'bundled'} недоступен`, error);
        continue;
      }
    }
  } catch (error) {
    log.debug('playwright-core не установлен — PDF недоступен, отдаём печатный HTML', error);
  }
  return null;
}

export function renderReportsIndexHtml(reports: ReportRecord[]): string {
  const rows = reports
    .map(
      (report) => `<tr>
        <td>${escapeXml(report.title)}</td>
        <td>${escapeXml(report.type)}</td>
        <td>${escapeXml(report.periodFrom)} — ${escapeXml(report.periodTo)}</td>
        <td>${escapeXml(report.status)}</td>
        <td><a href="/api/reports/${report.id}/html" target="_blank">открыть</a></td>
      </tr>`,
    )
    .join('');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Отчёты MARK</title>
  <style>body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:32px;color:#111827}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left}th{background:#f9fafb}a{color:#2563eb}</style>
  </head><body><h1>Исторические отчёты</h1><table><thead><tr><th>Отчёт</th><th>Тип</th><th>Период</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
