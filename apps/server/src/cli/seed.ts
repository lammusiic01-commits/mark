import process from 'node:process';
import type { Campaign } from '@mark/shared';
import { config } from '../config.js';
import { repos } from '../db/repos.js';
import { rootLogger } from '../logger.js';
import { demoLogSample, ensureDemoData } from '../seed.js';
import { simulateMetrics } from '../services/campaigns.js';

/**
 * CLI для работы с демо-данными:
 *   npm run seed               — создать демо-тенант (если его ещё нет)
 *   npm run seed -- --refresh  — пересчитать метрики кампаний (7/30 дней)
 *   npm run seed -- --log      — напечатать демо-образец лога (удобно для BotShield)
 */

const log = rootLogger.child('cli.seed');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--log')) {
    process.stdout.write(demoLogSample());
    return;
  }

  const result = await ensureDemoData();
  process.stdout.write(
    result.created
      ? `Демо-данные созданы: тенант ${result.tenantId}, клиентов ${result.clients}, сайтов ${result.sites}, кампаний ${result.campaigns}, гипотез ${result.hypotheses}, правил ${result.rules}\n`
      : `Демо-тенант уже существует (${result.tenantId}) — данные не пересоздавались.\n`,
  );

  if (argv.includes('--refresh')) {
    const db = await repos();
    const campaigns = db.campaign.list({ limit: 500 });
    let updated = 0;
    for (const item of campaigns) {
      const campaign = item as unknown as Campaign;
      const thirty = simulateMetrics(campaign, 30);
      db.campaign.patch(item.id, {
        metrics7d: simulateMetrics(campaign, 7).metrics,
        metrics30d: thirty.metrics,
        trend: thirty.trend,
        lastSyncedAt: new Date().toISOString(),
      } as never);
      updated += 1;
    }
    process.stdout.write(`Метрики обновлены у ${updated} кампаний.\n`);
  }

  process.stdout.write(`Данные лежат в ${config.dataDir}/mark.sqlite\n`);
}

main().catch((error) => {
  log.error('Ошибка наполнения демо-данными', error);
  process.exit(1);
});
