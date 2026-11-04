/** Deadline calculations are explicit about the venue's timezone and never use the host timezone. */
export interface DeadlineFields { deadline?: string; deadlineAt?: string; deadlineTimezone?: string }
export interface DeadlineConfiguration { deadline: string; deadlineAt: string; deadlineTimezone: string }
export interface CountdownParts { expired: boolean; totalMinutes: number; days: number; hours: number; minutes: number }
interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }
const wallPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
function utcTime(parts: WallTime): number {
  const date = new Date(0); date.setUTCFullYear(parts.year, parts.month - 1, parts.day); date.setUTCHours(parts.hour, parts.minute, parts.second, 0); return date.getTime();
}
function validWall(parts: WallTime): boolean {
  if (parts.year < 1970 || parts.year > 9999 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59 || parts.second < 0 || parts.second > 59) return false;
  const date = new Date(utcTime(parts)); return date.getUTCFullYear() === parts.year && date.getUTCMonth() + 1 === parts.month && date.getUTCDate() === parts.day;
}
function parseWall(value: unknown): WallTime {
  if (typeof value !== 'string') throw new Error('请填写截止日期与时间。');
  const match = wallPattern.exec(value);
  if (!match) throw new Error('截止日期与时间格式应为 YYYY-MM-DDTHH:mm，可附带秒数。');
  const parts = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: match[6] ? +match[6] : 0 };
  if (!validWall(parts)) throw new Error('截止日期或时间无效。');
  return parts;
}
export function validateDeadlineTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value)) throw new Error('请明确填写 IANA 时区，例如 Asia/Shanghai、UTC 或 Etc/GMT+12（AoE）。');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(0); } catch { throw new Error('时区无效，请使用 IANA 时区名称。'); }
  return value;
}
function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
function wallAt(epoch: number, format: Intl.DateTimeFormat): WallTime {
  const parts = Object.fromEntries(format.formatToParts(epoch).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}
function localString(parts: WallTime): string {
  const n = (value: number) => String(value).padStart(2, '0');
  return `${String(parts.year).padStart(4, '0')}-${n(parts.month)}-${n(parts.day)}T${n(parts.hour)}:${n(parts.minute)}${parts.second ? `:${n(parts.second)}` : ''}`;
}
function parseUtcDeadline(value: unknown): { epoch: number; canonical: string } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)) throw new Error('截止时间应为带秒数的 UTC ISO 时间。');
  const epoch = Date.parse(value), canonical = Number.isFinite(epoch) ? new Date(epoch).toISOString() : '';
  if (!canonical || canonical.replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) throw new Error('截止时间无效。');
  return { epoch, canonical };
}
export function localDeadlineToUtc(local: string, timezone: string): string {
  const wanted = parseWall(local), zone = validateDeadlineTimezone(timezone), format = formatter(zone), nominal = utcTime(wanted);
  // Sample both sides of any nearby civil-time transition, then round-trip each offset.
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = nominal + hours * 3600000; offsets.add(utcTime(wallAt(sample, format)) - sample);
  }
  const candidates = Array.from(offsets).map(offset => nominal - offset).filter(epoch => {
    const actual = wallAt(epoch, format); return actual.year === wanted.year && actual.month === wanted.month && actual.day === wanted.day && actual.hour === wanted.hour && actual.minute === wanted.minute && actual.second === wanted.second;
  });
  if (!candidates.length) throw new Error('该当地时间不存在，可能位于夏令时跳变区间；请核对或改用 UTC。');
  if (candidates.length > 1) throw new Error('该当地时间出现两次，存在夏令时歧义；请明确 UTC 时间后使用 UTC 时区。');
  return new Date(candidates[0]).toISOString();
}
export function formatDeadlineLocal(deadlineAt: string, timezone: string): string {
  validateDeadlineTimezone(timezone);
  const { epoch } = parseUtcDeadline(deadlineAt);
  return localString(wallAt(epoch, formatter(timezone)));
}
export function validateDeadlineConfiguration(deadlineAt: unknown, deadlineTimezone: unknown): DeadlineConfiguration {
  const { canonical } = parseUtcDeadline(deadlineAt);
  const timezone = validateDeadlineTimezone(deadlineTimezone), local = formatDeadlineLocal(canonical, timezone);
  if (localDeadlineToUtc(local, timezone) !== canonical) throw new Error('截止时间与时区不一致。');
  return { deadlineAt: canonical, deadlineTimezone: timezone, deadline: local.slice(0, 10) };
}
export function validLegacyDeadline(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('截止日期请使用 YYYY-MM-DD；精确截止时间请同时填写时间与时区。');
  parseWall(`${value}T00:00`); return value;
}
export function deadlineCountdown(deadlineAt: string, now = Date.now()): CountdownParts {
  const { epoch } = parseUtcDeadline(deadlineAt); if (!Number.isFinite(now)) throw new Error('当前时间无效。');
  const remaining = epoch - now, expired = remaining <= 0;
  const totalMinutes = expired ? Math.floor(-remaining / 60000) : Math.floor(remaining / 60000);
  return { expired, totalMinutes, days: Math.floor(totalMinutes / 1440), hours: Math.floor(totalMinutes % 1440 / 60), minutes: totalMinutes % 60 };
}
export function countdownText(parts: CountdownParts): string {
  const duration = [parts.days ? `${parts.days}天` : '', parts.days || parts.hours ? `${parts.hours}小时` : '', `${parts.minutes}分`].filter(Boolean).join(' ');
  return parts.expired ? parts.totalMinutes ? `已截止 ${duration}` : '已截止' : parts.totalMinutes ? `正文截止剩余 ${duration}` : '正文截止剩余不足1分';
}
