import type { AuthModeId, ValidationResult } from '@mark/shared';
import { getService } from '@mark/shared';
import { rootLogger } from '../../logger.js';
import { CheckRunner, type ValidationContext } from './context.js';
import type { Validator, ValidatorOutcome } from './types.js';
import {
  validateYandexBusiness,
  validateYandexDirect,
  validateYandexGpt,
  validateYandexMetrika,
  validateYandexWebmaster,
} from './validators/yandex.js';
import {
  validateGoogleAds,
  validateGoogleAnalytics,
  validateGoogleBusinessProfile,
  validateGoogleSearchConsole,
} from './validators/google.js';
import {
  validateCloudflare,
  validateFtpHosting,
  validateGithub,
  validateNetlify,
  validateSftpHosting,
  validateTilda,
  validateVercel,
  validateWebflow,
  validateWordPress,
} from './validators/site.js';
import {
  validateBrowserSession,
  validateIndexNow,
  validateOpenAi,
  validateSmtp,
  validateTelegram,
  validateVkAds,
  validateVkMetrika,
} from './validators/misc.js';

const log = rootLogger.child('validation');

/** Реестр валидаторов: сервис → функция проверки. */
export const VALIDATORS: Record<string, Validator> = {
  'yandex-direct': validateYandexDirect,
  'yandex-metrika': validateYandexMetrika,
  'yandex-webmaster': validateYandexWebmaster,
  'yandex-business': validateYandexBusiness,
  'yandex-gpt': validateYandexGpt,
  'google-ads': validateGoogleAds,
  'google-analytics': validateGoogleAnalytics,
  'google-search-console': validateGoogleSearchConsole,
  'google-business-profile': validateGoogleBusinessProfile,
  'vk-ads': validateVkAds,
  'vk-metrika': validateVkMetrika,
  tilda: validateTilda,
  wordpress: validateWordPress,
  vercel: validateVercel,
  netlify: validateNetlify,
  github: validateGithub,
  webflow: validateWebflow,
  cloudflare: validateCloudflare,
  'ftp-hosting': validateFtpHosting,
  telegram: validateTelegram,
  'email-smtp': validateSmtp,
  openai: validateOpenAi,
  indexnow: validateIndexNow,
};

/** Режимы авторизации, где учётные данные — это сессия браузера (cookies). */
const SESSION_MODES: AuthModeId[] = ['browser_login', 'cookie_import'];

export function isSessionMode(mode: AuthModeId): boolean {
  return SESSION_MODES.includes(mode);
}

/** Выбор валидатора: для сервиса, а для сессионных режимов — универсальный. */
export function resolveValidator(serviceId: string, authMode: AuthModeId): { name: string; validator: Validator } {
  if (isSessionMode(authMode)) {
    return { name: 'browser-session', validator: validateBrowserSession };
  }
  const service = getService(serviceId);
  if (!service) throw new Error(`Неизвестный сервис: ${serviceId}`);
  const mode = service.authModes.find((m) => m.id === authMode);
  if (!mode) {
    throw new Error(`Способ авторизации «${authMode}» не поддерживается сервисом ${service.name}`);
  }
  const validator = VALIDATORS[serviceId];
  if (!validator) {
    return { name: 'generic', validator: genericInfoValidator(serviceId) };
  }
  return { name: serviceId, validator };
}

/** Если для сервиса нет спец-проверки: показываем план и честно помечаем статус. */
function genericInfoValidator(serviceId: string): Validator {
  return async (ctx, runner) => {
    const service = getService(serviceId);
    await runner.step('plan', 'План проверки', async () => {
      return {
        status: 'warn' as const,
        message: `Для ${service?.name ?? serviceId} пока нет автоматической проверки. Учётные данные сохранены в зашифрованном виде, проверка выполнится при первой задаче.`,
      };
    });
    return { accountInfo: { pending: true } };
  };
}

/**
 * Запуск полной проверки подключения с публикацией шагов в реальном времени.
 * `emit` вызывается на каждое изменение шага — фронтенд рисует прогресс.
 */
export async function runValidation(ctx: ValidationContext): Promise<ValidationResult> {
  const service = getService(ctx.serviceId);
  const runner = new CheckRunner(ctx);
  const started = Date.now();
  let outcome: ValidatorOutcome = {};

  try {
    const { validator, name } = resolveValidator(ctx.serviceId, ctx.authMode);
    log.info(`Проверка ${ctx.serviceId} (${ctx.authMode}) через ${name}`, { sandbox: ctx.sandbox });
    ctx.emit('started', {
      serviceId: ctx.serviceId,
      authMode: ctx.authMode,
      serviceName: service?.name,
      plan: service?.validationPlan ?? [],
      sandbox: ctx.sandbox,
    });
    outcome = (await validator(ctx, runner)) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.emit('error', { message });
    runner.skip('fatal', 'Проверка прервана', message);
  }

  const result = runner.build(outcome.accountInfo, outcome.capabilities);
  ctx.emit('finished', result);
  log.info(`Проверка ${ctx.serviceId} завершена за ${Date.now() - started} мс: ${result.status}`, {
    checks: result.checks.map((c) => `${c.key}=${c.status}`).join(' '),
  });
  return result;
}

/** Подсказка для UI: как получить токен (берётся из каталога). */
export function authModeHelp(serviceId: string, authMode: AuthModeId): string[] {
  const service = getService(serviceId);
  const mode = service?.authModes.find((m) => m.id === authMode);
  if (!service || !mode) return [];
  const hints = [mode.description];
  if (mode.needsInAppLogin) {
    hints.push('Можно войти в аккаунт прямо в окне приложения — MARK сохранит сессию и будет работать от вашего имени.');
  }
  if (mode.automation === 'partial') hints.push('Часть действий потребует ручного подтверждения в интерфейсе сервиса.');
  if (mode.automation === 'manual') hints.push('Этот способ не даёт автоматизации: MARK подготовит готовые файлы и инструкцию.');
  return hints;
}
