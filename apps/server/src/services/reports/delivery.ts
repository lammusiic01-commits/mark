import fs from 'node:fs';
import type { ReportRecord } from '@mark/shared';
import { formatBytes } from '@mark/shared';
import { config } from '../../config.js';
import { decryptJson } from '../../crypto.js';
import { repos } from '../../db/repos.js';
import { rootLogger } from '../../logger.js';
import { SmtpClient } from '../smtp.js';
import { formatAlert, sendTelegramMessage } from '../telegram.js';
import { renderReportHtml } from './renderer.js';

/**
 * Доставка отчётов: e-mail (SMTP), Telegram и «в приложении».
 * SMTP-клиент собственный (см. services/smtp.ts), поэтому доставка работает
 * без внешних зависимостей — только логин/пароль почтового сервера.
 */

const log = rootLogger.child('report-delivery');

export async function deliverReport(
  tenantId: string,
  report: ReportRecord,
  channelsInput: ('download' | 'email' | 'telegram')[],
  recipients: string[],
): Promise<ReportRecord['delivery']> {
  const db = await repos();
  const results: ReportRecord['delivery'] = [];

  if (channelsInput.includes('download') || !channelsInput.length) {
    results.push({ channel: 'download', status: 'sent', target: report.filePath ?? 'in-app' });
  }

  if (channelsInput.includes('email')) {
    const smtpAccount = db.account.list({ tenantId, limit: 200 }).find((item) => item.serviceId === 'email-smtp');
    const settings = db.kv.get<{ reportEmail?: string }>(`settings:${tenantId}`);
    const to = recipients.length ? recipients : [settings?.reportEmail ?? ''].filter(Boolean);

    if (!smtpAccount) {
      results.push({ channel: 'email', status: 'failed', error: 'SMTP не подключён — добавьте сервер в разделе «Подключения»' });
    } else if (!to.length) {
      results.push({ channel: 'email', status: 'failed', error: 'Не указаны получатели отчёта' });
    } else {
      try {
        const payload = db.secrets.load(smtpAccount.id);
        const secrets = payload ? decryptJson<Record<string, string>>(payload) : {};
        const html = renderReportHtml(report, { forPrint: false });
        const attachmentPath = report.filePath;
        const attachments =
          attachmentPath && fs.existsSync(attachmentPath)
            ? [{ filename: `${report.title.replace(/[^\wа-яА-ЯёЁ\- ]/g, '')}.html`, content: fs.readFileSync(attachmentPath), contentType: 'text/html' }]
            : undefined;

        const client = new SmtpClient({
          host: secrets.host ?? '',
          port: Number(secrets.port ?? 465),
          secure: (secrets.secure as 'tls' | 'starttls' | 'none') ?? 'tls',
          user: secrets.user,
          password: secrets.password,
          from: secrets.from ?? secrets.user ?? '',
        });
        await client.connect();
        await client.prepare();
        await client.authenticate();
        for (const recipient of to) {
          await client.sendMail({
            to: [recipient],
            subject: `${report.branding.agencyName}: ${report.title}`,
            text: `${report.title}\n\nПериод: ${report.periodFrom} — ${report.periodTo}\nKPI: ${report.kpis.map((kpi) => `${kpi.label} — ${kpi.value}`).join(', ')}\n\nОтчёт во вложении (HTML, открывается в браузере и печатается в PDF).`,
            html,
            attachments,
          });
          results.push({ channel: 'email', status: 'sent', target: recipient });
        }
        await client.quit();
        log.info(`Отчёт ${report.id} отправлен на ${to.length} адресов`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ channel: 'email', status: 'failed', error: message });
        log.warn('Не удалось отправить отчёт по e-mail', { error: message });
      }
    }
  }

  if (channelsInput.includes('telegram')) {
    const text = formatAlert(`${report.branding.agencyName}: отчёт готов`, [
      report.title,
      `Период: ${report.periodFrom} — ${report.periodTo}`,
      ...report.kpis.slice(0, 4).map((kpi) => `${kpi.label}: ${kpi.value}${kpi.delta ? ` (${kpi.delta > 0 ? '+' : ''}${kpi.delta}%)` : ''}`),
      report.filePath ? `Файл: ${report.filePath.split(/[/\\]/).pop()} (${formatBytes(report.fileSizeBytes ?? 0)})` : 'Файл сохранён в .data/reports',
    ]);
    const result = await sendTelegramMessage(tenantId, text);
    results.push({ channel: 'telegram', status: result.ok ? 'sent' : 'failed', error: result.ok ? undefined : result.error });
  }

  db.events.log({
    tenantId,
    type: 'report',
    level: results.some((item) => item.status === 'failed') ? 'warn' : 'info',
    message: `Отчёт «${report.title}»: ${results.map((item) => `${item.channel}=${item.status}`).join(', ')}`,
    payload: { reportId: report.id },
  });

  return results;
}

export const reportsDir = config.reportsDir;
