// مواعيد المهام المجدولة (SPEC §9) بصيغة Cloudflare. أيام الأسبوع فيها من 1 = الأحد إلى 7 = السبت،
// لا 0 = الأحد كما في cron الشائع الذي كُتبت به SPEC. لذلك تُكتب الأيام بأسمائها المختصرة (SUN)
// كما يوصي توثيق Cloudflare، ويجب أن تطابق [triggers] في wrangler.toml (NOTES.md القسم 2.13).

export const CRON_DAILY = '0 6 * * *'; // يومياً 9:00 ص بتوقيت الرياض
export const CRON_WEEKLY_PLAN = '0 5 * * SUN'; // الأحد 8:00 ص
export const CRON_MIDWEEK_EVENTS = '0 5 * * WED'; // الأربعاء 8:00 ص (NOTES.md القسم 11)
export const CRON_WEEKLY_REPORT = '0 14 * * THU'; // الخميس 5:00 م

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * صيغة موحّدة لتعبير cron كما يمرّره Cloudflare (controller.cron)، حتى يطابق مفاتيح المهام
 * ولو اختلفت حالة الأحرف أو المسافات، أو جاء اليوم رقماً بترقيم Cloudflare (1 = الأحد).
 */
export function cronKey(cron: string): string {
  const fields = cron.trim().toUpperCase().split(/\s+/);
  const day = fields[4];
  if (fields.length === 5 && day && /^[1-7]$/.test(day)) fields[4] = DAY_NAMES[Number(day) - 1]!;
  return fields.join(' ');
}
