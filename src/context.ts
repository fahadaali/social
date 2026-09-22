// سياق تنفيذ مهمة واحدة: البيئة، ومحادثة المالك، والمهلة المتبقية.

import type { Env } from './env.ts';

// ctx.waitUntil يمنح 30 ثانية بعد إرسال الرد لتيليجرام (SPEC §2)؛ نترك هامشاً للإبلاغ عن الفشل.
export const WEBHOOK_BUDGET_MS = 27_000;
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
