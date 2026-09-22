// تحويل توقيت الرياض ↔ UTC (SPEC §2): الرياض = UTC+3 دائماً، بلا توقيت صيفي.

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const MONTHS_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

export interface RiyadhParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = الأحد
}

export function riyadhParts(d: Date): RiyadhParts {
  const r = new Date(d.getTime() + RIYADH_OFFSET_MS);
  return {
    year: r.getUTCFullYear(),
    month: r.getUTCMonth() + 1,
    day: r.getUTCDate(),
    hour: r.getUTCHours(),
    minute: r.getUTCMinutes(),
    weekday: r.getUTCDay(),
  };
}

/** وقت بتوقيت الرياض → لحظة UTC. تجاوز اليوم لنهاية الشهر يُعالج تلقائياً. */
export function riyadhToUtc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - RIYADH_OFFSET_MS);
}

/** صيغة SQLite لـ datetime('now'): 'YYYY-MM-DD HH:MM:SS' بتوقيت UTC. */
export function toSqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** يقرأ صيغة SQLite أو RFC3339. */
export function parseUtc(s: string): Date {
  const t = s.trim();
  if (t.includes('T')) return new Date(t);
  return new Date(t.replace(' ', 'T') + 'Z');
}

/** RFC3339 بلا أجزاء الثانية، كما تطلبه SocialAPI في scheduled_at. */
export function toRfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatClock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'ص' : 'م';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** مثال: «الخميس 24 سبتمبر، 8:00 م» بتوقيت الرياض. */
export function formatRiyadh(d: Date): string {
  const p = riyadhParts(d);
  return `${WEEKDAYS_AR[p.weekday]} ${p.day} ${MONTHS_AR[p.month - 1]}، ${formatClock(p.hour, p.minute)}`;
}

/** مثال: «الاثنين 22 سبتمبر 2026». */
export function formatRiyadhDate(d: Date): string {
  const p = riyadhParts(d);
  return `${WEEKDAYS_AR[p.weekday]} ${p.day} ${MONTHS_AR[p.month - 1]} ${p.year}`;
}

export interface ScheduleOption {
  label: string;
  at: Date;
}

/**
 * خيارات الجدولة (SPEC §7): اليوم 8م، غداً 8ص، غداً 8م، بعد غد 8ص — بتوقيت الرياض.
 * يُستبعد أي خيار أقرب من minLeadMinutes (مثلاً «اليوم 8م» بعد فواته).
 */
export function scheduleOptions(now: Date, minLeadMinutes = 15): ScheduleOption[] {
  const p = riyadhParts(now);
  const at = (dayOffset: number, hour: number) => riyadhToUtc(p.year, p.month, p.day + dayOffset, hour);
  return [
    { label: 'اليوم 8م', at: at(0, 20) },
    { label: 'غداً 8ص', at: at(1, 8) },
    { label: 'غداً 8م', at: at(1, 20) },
    { label: 'بعد غد 8ص', at: at(2, 8) },
  ].filter((o) => o.at.getTime() - now.getTime() >= minLeadMinutes * 60_000);
}

/** عدد الأيام الكاملة المنقضية بين لحظتين. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
