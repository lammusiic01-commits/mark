/** Работа с IPv4/IPv6 CIDR-диапазонами (для проверки поисковых ботов по IP). */

export function ipv4ToLong(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = value * 256 + num;
  }
  return value;
}

export function longToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function parseCidr(cidr: string): { start: number; end: number } | null {
  const [ip, bitsRaw] = cidr.trim().split('/');
  if (!ip) return null;
  const base = ipv4ToLong(ip);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const start = (base & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const value = ipv4ToLong(ip);
  const range = parseCidr(cidr);
  if (value === null || !range) return false;
  return value >= range.start && value <= range.end;
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => ipv4InCidr(ip, cidr));
}

/** Является ли адрес приватным/локальным (безопасность: не блокируем свои же). */
export function isPrivateIp(ip: string): boolean {
  const value = ipv4ToLong(ip);
  if (value === null) return false;
  const ranges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'];
  return ipInAnyCidr(ip, ranges);
}

/** Нормализация записи из лога (может содержать порт: 1.2.3.4:5678). */
export function normalizeIp(raw: string): string {
  if (!raw) return '';
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':') && !ip.includes('.')) return ip; // IPv6 как есть
  if (ip.includes(':')) ip = ip.split(':')[0] ?? ip;
  return ip;
}

export const isIpv4 = (value: string) => ipv4ToLong(value) !== null;
