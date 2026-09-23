// الأسرار والمتغيرات (SPEC §3) وقراءتها بأمان.

export interface Env {
  DB: D1Database;
  /** Workers AI لتفريغ الرسائل الصوتية (وافق عليه المالك — NOTES.md القسم 6). */
  AI: Ai;

  // أسرار (من لوحة Cloudflare بنوع Secret، أو wrangler secret put)
  TELEGRAM_BOT_TOKEN: string;
  /** اختياري: بدونه يُشتق سر الـ webhook من توكن البوت (auth.ts). */
  TELEGRAM_WEBHOOK_SECRET?: string;
  ANTHROPIC_API_KEY: string;
  SOCIALAPI_KEY: string;

  // متغيرات تُضبط من لوحة Cloudflare (قد تغيب حتى تُضبط، فتُقرأ بأمان أدناه)
  ALLOWED_TELEGRAM_USER_ID?: string;
  SOCIALAPI_X_ACCOUNT_ID?: string;
  SOCIALAPI_LINKEDIN_ACCOUNT_ID?: string;
  /** غيابه = وضع التجربة مفعّل (الافتراض الآمن). */
  DRY_RUN?: string;

  // متغيرات لها قيم في [vars] بـ wrangler.toml
  CLAUDE_MODEL: string;
  CLAUDE_MODEL_FAST: string;
  REMINDER_AFTER_DAYS: string;
  MONTHLY_POST_LIMIT: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** معرّف المالك، أو null إذا لم يُضبط (عندها يتجاهل البوت كل التحديثات). */
export function ownerId(env: Env): string | null {
  const id = str(env.ALLOWED_TELEGRAM_USER_ID);
  return /^\d+$/.test(id) ? id : null;
}

/** وضع التجربة مفعّل ما لم تُضبط القيمة صراحةً على false (الافتراض الآمن). */
export function isDryRun(env: Env): boolean {
  return str(env.DRY_RUN).toLowerCase() !== 'false';
}

function positiveInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const reminderAfterDays = (env: Env): number => positiveInt(env.REMINDER_AFTER_DAYS, 4);
export const monthlyPostLimit = (env: Env): number => positiveInt(env.MONTHLY_POST_LIMIT, 10);
export const draftModel = (env: Env): string => str(env.CLAUDE_MODEL) || 'claude-sonnet-5';
export const fastModel = (env: Env): string => str(env.CLAUDE_MODEL_FAST) || 'claude-haiku-4-5-20251001';

export type Platform = 'x' | 'linkedin';
export const PLATFORMS: readonly Platform[] = ['x', 'linkedin'];
export const PLATFORM_LABEL: Record<Platform, string> = { x: 'X', linkedin: 'لينكدن' };

/** معرّف حساب المنصة في SocialAPI، أو null إذا لم يُضبط. */
export function accountId(env: Env, platform: Platform): string | null {
  const id = str(platform === 'x' ? env.SOCIALAPI_X_ACCOUNT_ID : env.SOCIALAPI_LINKEDIN_ACCOUNT_ID);
  return id || null;
}
