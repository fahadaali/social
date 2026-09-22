// المهام المجدولة (SPEC §9). Cron لا يعيد المحاولة عند الفشل، لذلك يُبلَّغ المالك بأي فشل.

import { claudeErrorMessage, ClaudeError } from '../claude.ts';
import { CRON_BUDGET_MS, makeCtx, type Ctx } from '../context.ts';
import { cleanupProcessedUpdates, countUpcomingScheduled, getState } from '../db.ts';
import { ownerId, reminderAfterDays, type Env } from '../env.ts';
import { CB } from '../preview.ts';
import { followUpPosts, LAST_PUBLISHED_KEY } from '../publishing.ts';
import { SocialApiError, socialApiErrorMessage } from '../socialapi.ts';
import { button, sendMessage, TelegramError } from '../telegram.ts';
import { daysBetween, parseUtc } from '../time.ts';

export const CRON_DAILY = '0 6 * * *'; // 9:00 ص بتوقيت الرياض

export const REMINDERS_PAUSED_KEY = 'reminders_paused';

/** ملخص خطأ قصير بلا تفاصيل حساسة. */
export function errorSummary(err: unknown): string {
  if (err instanceof SocialApiError) return socialApiErrorMessage(err);
  if (err instanceof ClaudeError) return claudeErrorMessage(err);
  if (err instanceof TelegramError) return `تيليجرام (${err.code})`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'خطأ غير معروف';
}

export function daysAr(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/** (ب) تذكير عند انقطاع النشر: لا تذكير إن كانت التذكيرات موقوفة أو يوجد منشور مجدول قادم. */
export async function maybeRemind(ctx: Ctx): Promise<boolean> {
  const db = ctx.env.DB;
  const paused = await getState(db, REMINDERS_PAUSED_KEY);
  if (paused === '1' || paused === 'true') return false;
  if ((await countUpcomingScheduled(db)) > 0) return false;

  const last = await getState(db, LAST_PUBLISHED_KEY);
  const days = last ? daysBetween(parseUtc(last), new Date()) : null;
  if (days !== null && days < reminderAfterDays(ctx.env)) return false;

  const text =
    days === null
      ? '⏰ لم يُنشر شيء عبر البوت بعد. ما رأيك نجهّز أول منشور اليوم؟'
      : `⏰ مرّ ${daysAr(days)} على آخر نشر. ما رأيك نجهّز منشوراً اليوم؟`;
  await sendMessage(ctx.env, ctx.chatId, text, {
    inline_keyboard: [[button('اقترح موضوعاً', CB.plan()), button('أفكاري', CB.ideas())]],
  });
  return true;
}

/** المهمة اليومية: (أ) متابعة المنشورات، (ب) التذكير، (ج) تنظيف processed_updates. */
async function daily(ctx: Ctx): Promise<string[]> {
  const failures: string[] = [];
  try {
    const r = await followUpPosts(ctx);
    failures.push(...r.errors.map((e) => `متابعة المنشورات: ${e}`));
  } catch (err) {
    failures.push(`متابعة المنشورات: ${errorSummary(err)}`);
  }
  try {
    await maybeRemind(ctx);
  } catch (err) {
    failures.push(`التذكير: ${errorSummary(err)}`);
  }
  try {
    await cleanupProcessedUpdates(ctx.env.DB);
  } catch (err) {
    failures.push(`تنظيف السجلات: ${errorSummary(err)}`);
  }
  return failures;
}

interface CronTask {
  name: string;
  run: (ctx: Ctx) => Promise<string[]>;
}

const TASKS: Record<string, CronTask> = {
  [CRON_DAILY]: { name: 'المتابعة اليومية', run: daily },
};

export async function runScheduled(env: Env, cron: string): Promise<void> {
  const task = TASKS[cron];
  if (!task) {
    console.warn(JSON.stringify({ evt: 'unknown_cron', cron }));
    return;
  }
  const owner = ownerId(env);
  if (!owner) {
    console.error(JSON.stringify({ evt: 'cron_skipped', reason: 'ALLOWED_TELEGRAM_USER_ID not set' }));
    return;
  }
  const ctx = makeCtx(env, Number(owner), CRON_BUDGET_MS);
  let failures: string[];
  try {
    failures = await task.run(ctx);
  } catch (err) {
    failures = [errorSummary(err)];
  }
  if (failures.length === 0) return;

  console.error(JSON.stringify({ evt: 'cron_failed', task: task.name, count: failures.length }));
  try {
    await sendMessage(env, ctx.chatId, `⚠️ فشلت مهمة ${task.name}: ${failures.join(' | ')}`);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'cron_notify_failed', code: err instanceof TelegramError ? err.code : 'unknown' }));
  }
  // تُسجَّل المهمة فاشلة في لوحة Cloudflare أيضاً
  throw new Error(`cron task failed: ${task.name}`);
}
