// سياق تنفيذ مهمة واحدة: البيئة، ومحادثة المالك، والمهلة المتبقية.

import type { Env } from './env.ts';

// ctx.waitUntil يمنح 30 ثانية بعد إرسال الرد لتيليجرام (SPEC §2)؛ نترك هامشاً للإبلاغ عن الفشل.
export const WEBHOOK_BUDGET_MS = 27_000;
// مستهلك طابور الصياغة له 15 دقيقة (NOTES.md القسم 3). 5 دقائق تكفي أسوأ الحالات: مسودة وتصحيحها،
// ثم مراجعة الأسلوب وإعادة الكتابة ومراجعتها (60 ثانية حداً لكل محاولة في claude.ts)،
// وتبقى قصيرة فلا تُترك رسالة «جاري الصياغة…» طويلاً. الغالب أقل من دقيقة ونصف.
export const QUEUE_BUDGET_MS = 300_000;
// مهام Cron لها مهلة أطول، ومع ذلك نبقيها قصيرة.
export const CRON_BUDGET_MS = 120_000;

export interface Ctx {
  env: Env;
  chatId: number;
  /** لحظة (epoch ms) يجب إنهاء العمل قبلها. */
  deadline: number;
}

export function makeCtx(env: Env, chatId: number, budgetMs: number): Ctx {
  return { env, chatId, deadline: Date.now() + budgetMs };
}

export const remaining = (ctx: Ctx): number => ctx.deadline - Date.now();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
