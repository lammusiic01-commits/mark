import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { rootLogger } from './logger.js';

/**
 * Шифрование секретов (токены, пароли, cookies) — AES-256-GCM.
 *
 * Ключ берётся из MARK_VAULT_KEY (base64/hex) или генерируется в .data/vault.key.
 * В git-репозиторий .data не попадает (см. .gitignore), поэтому секреты
 * никогда не окажутся в исходниках.
 */

const log = rootLogger.child('vault');

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.MARK_VAULT_KEY;
  if (fromEnv) {
    const buf = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error('MARK_VAULT_KEY должен быть 32 байта (base64 или hex)');
    cachedKey = buf;
    return cachedKey;
  }
  const file = config.vaultKeyFile;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) {
      cachedKey = buf;
      return cachedKey;
    }
    log.warn('Файл ключа повреждён, создаём новый (старые секреты нужно ввести заново)');
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(file, generated.toString('base64'), { mode: 0o600 });
  log.info('Создан новый ключ хранилища секретов', { file });
  cachedKey = generated;
  return cachedKey;
}

export function encryptText(plain: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptText(payload: string): string {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Некорректный формат секрета');
    const key = loadKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    log.error('Не удалось расшифровать секрет', error);
    throw new Error('Секрет повреждён или ключ хранилища изменён. Переподключите сервис.');
  }
}

export function encryptJson(value: unknown): string {
  return encryptText(JSON.stringify(value ?? null));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptText(payload)) as T;
}

export const randomId = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Маскирование секрета для интерфейса. */
export function maskSecret(value?: string | null, visible = 4): string | null {
  if (!value) return null;
  const clean = String(value);
  if (clean.length <= visible) return '•'.repeat(Math.max(4, clean.length));
  return `${clean.slice(0, visible)}${'•'.repeat(Math.min(16, Math.max(4, clean.length - visible)))}`;
}

/** Стабильный отпечаток секрета (для проверки «тот же токен?» без хранения). */
export function fingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
