import crypto from 'node:crypto';
import { httpJson } from '../http/client.js';
import { rootLogger } from '../logger.js';

/**
 * Получение access_token для Google API любым из поддерживаемых способов:
 *  1) готовый access_token;
 *  2) refresh_token + client_id/client_secret (обмен по OAuth2);
 *  3) JSON сервисного аккаунта (JWT-подпись RS256, grant_type=jwt-bearer).
 *
 * Используется валидаторами подключений и сервисами выгрузки данных
 * (Google Ads, GA4, Search Console, Business Profile).
 */

const log = rootLogger.child('google-auth');

export interface GoogleCredentials {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  serviceAccountJson?: string;
  scopes?: string[];
}

export interface GoogleTokenResult {
  ok: boolean;
  token: string | null;
  method: 'access_token' | 'refresh_token' | 'service_account' | 'none';
  expiresIn?: number;
  error?: string;
  info?: Record<string, unknown>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
];

interface ServiceAccountKey {
  client_email?: string;
  private_key?: string;
  project_id?: string;
  token_uri?: string;
}

function parseServiceAccount(raw: string): ServiceAccountKey {
  try {
    return JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new Error('JSON сервисного аккаунта не разобран. Скопируйте файл ключа целиком.');
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** JWT-подпись для сервисного аккаунта (RS256). */
export function signServiceAccountJwt(key: ServiceAccountKey, scope: string): string {
  if (!key.client_email || !key.private_key) {
    throw new Error('В JSON сервисного аккаунта нет client_email или private_key');
  }
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: undefined as string | undefined };
  const claims = {
    iss: key.client_email,
    scope,
    aud: key.token_uri ?? TOKEN_URL,
    exp: iat + 3600,
    iat,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(key.private_key.replace(/\\n/g, '\n'));
  return `${signingInput}.${base64Url(signature)}`;
}

export async function resolveGoogleAccessToken(credentials: GoogleCredentials): Promise<GoogleTokenResult> {
  const scopes = credentials.scopes?.length ? credentials.scopes.join(' ') : DEFAULT_SCOPES.join(' ');

  if (credentials.serviceAccountJson) {
    try {
      const key = parseServiceAccount(credentials.serviceAccountJson);
      const assertion = signServiceAccountJwt(key, scopes);
      const result = await httpJson<{ access_token?: string; expires_in?: number; error_description?: string }>(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      if (!result.ok || !result.data?.access_token) {
        return {
          ok: false,
          token: null,
          method: 'service_account',
          error: result.data?.error_description ?? `Google отклонил JWT (HTTP ${result.status})`,
        };
      }
      log.info('Получен токен сервисного аккаунта', { account: key.client_email });
      return {
        ok: true,
        token: result.data.access_token,
        method: 'service_account',
        expiresIn: result.data.expires_in,
        info: { clientEmail: key.client_email, projectId: key.project_id },
      };
    } catch (error) {
      return {
        ok: false,
        token: null,
        method: 'service_account',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (credentials.refreshToken && credentials.clientId && credentials.clientSecret) {
    const result = await httpJson<{ access_token?: string; expires_in?: number; error_description?: string; error?: string }>(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      },
    );
    if (!result.ok || !result.data?.access_token) {
      return {
        ok: false,
        token: null,
        method: 'refresh_token',
        error: result.data?.error_description ?? result.data?.error ?? `Обмен refresh_token не удался (HTTP ${result.status})`,
      };
    }
    return { ok: true, token: result.data.access_token, method: 'refresh_token', expiresIn: result.data.expires_in };
  }

  if (credentials.accessToken) {
    return { ok: true, token: credentials.accessToken, method: 'access_token' };
  }

  return { ok: false, token: null, method: 'none', error: 'Не переданы учётные данные Google' };
}

/** Проверка токена через tokeninfo (быстро, без расхода квоты). */
export async function googleTokenInfo(accessToken: string) {
  const result = await httpJson<{ email?: string; scope?: string; aud?: string; expires_in?: number; error_description?: string }>(
    'https://oauth2.googleapis.com/tokeninfo',
    { query: { access_token: accessToken } },
  );
  if (!result.ok) {
    return { ok: false as const, error: result.data?.error_description ?? `tokeninfo вернул HTTP ${result.status}` };
  }
  const scopes = (result.data?.scope ?? '').split(' ').filter(Boolean);
  return {
    ok: true as const,
    email: result.data?.email ?? null,
    scopes,
    expiresIn: Number(result.data?.expires_in ?? 0),
  };
}
