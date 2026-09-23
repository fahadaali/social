// المهام المجدولة (SPEC §9). Cron لا يعيد المحاولة عند الفشل، لذلك يُبلَّغ المالك بأي فشل.

import { claudeErrorMessage, ClaudeError } from '../claude.ts';
import { collectPerformance, loadSnapshot, saveSnapshot } from '../analytics.ts';
import { CRON_BUDGET_MS, makeCtx, type Ctx } from '../context.ts';
import {
  cleanupProcessedUpdates,
  countUpcomingScheduled,
  getState,
  listDraftsByStatus,
  remindersPaused,
  STATE_KEYS,
} from '../db.ts';
import { ownerId, reminderAfterDays, type Env } from '../env.ts';
import { eventsErrorMessage, researchEvents } from '../events.ts';
import { ensureSchema } from '../migrations.ts';
import { CB } from '../preview.ts';
import { generateEventsPlan, generatePlan } from '../planning.ts';
import type { EventDigest } from '../prompts/events.ts';
import { followUpPosts } from '../publishing.ts';
import { buildReport } from '../reporting.ts';
import { SocialApiError, socialApiErrorMessage } from '../socialapi.ts';
import { draftTitle } from '../status.ts';
import { button, sendMessage, TelegramError } from '../telegram.ts';
import { daysAr, readyDraftsAr } from '../text.ts';
import { daysBetween, parseUtc } from '../time.ts';

// توقيت Cron بـ UTC؛ الرياض = UTC+3 (SPEC §9)
export const CRON_DAILY = '0 6 * * *'; // يومياً 9:00 ص
export const CRON_WEEKLY_PLAN = '0 5 * * 0'; // الأحد 8:00 ص
export const CRON_MIDWEEK_EVENTS = '0 5 * * 3'; // الأربعاء 8:00 ص (NOTES.md القسم 11)
export const CRON_WEEKLY_REPORT = '0 14 * * 4'; // الخميس 5:00 م

const SNAPSHOT_MAX_AGE_DAYS = 7;

// البحث في الويب قد يستغرق دقائق، ومهلة Cron في Cloudflare 15 دقيقة؛ نترك للخطة دقيقة بعد البحث
const EVENTS_TASK_BUDGET_MS = 6 * 60_000;
const PLAN_RESERVE_MS = 60_000;
const SUNDAY_EVENT_DAYS = 7;
const MIDWEEK_EVENT_DAYS = 4;

/** ملخص خطأ قصير بلا تفاصيل حساسة. */
export function errorSummary(err: unknown): string {
  if (err instanceof SocialApiError) return socialApiErrorMessage(err);
  if (err instanceof ClaudeError) return claudeErrorMessage(err);
  if (err instanceof TelegramError) return `تيليجرام (${err.code})`;
  if (err instanceof Error) return err.message.slice(0, 200);
  return 'خطأ غير معروف';
}

const REMINDER_SHOWN_DRAFTS = 3;

/**
 * (ب) تذكير عند انقطاع النشر: لا تذكير إن كانت التذكيرات موقوفة أو يوجد منشور مجدول قادم.
 * يبدأ بالمسودات المعلّقة الجاهزة (أسرع طريق للنشر) قبل اقتراح موضوع جديد.
 */
export async function maybeRemind(ctx: Ctx): Promise<boolean> {
  const db = ctx.env.DB;
  if (await remindersPaused(db)) return false;
  if ((await countUpcomingScheduled(db)) > 0) return false;

  const last = await getState(db, STATE_KEYS.lastPublishedAt);
  const days = last ? daysBetween(parseUtc(last), new Date()) : null;
  if (days !== null && days < reminderAfterDays(ctx.env)) return false;

  const since = days === null ? '⏰ لم يُنشر شيء عبر البوت بعد.' : `⏰ مرّ ${daysAr(days)} على آخر نشر.`;
  const planRow = [button('اقترح موضوعاً', CB.plan()), button('أفكاري', CB.ideas())];
  const ready = await listDraftsByStatus(db, ['pending'], 50, true);
  if (ready.length === 0) {
    const text = days === null ? `${since} ما رأيك نجهّز أول منشور اليوم؟` : `${since} ما رأيك نجهّز منشوراً اليوم؟`;
    await sendMessage(ctx.env, ctx.chatId, text, { inline_keyboard: [planRow] });
    return true;
  }
  const shown = ready.slice(0, REMINDER_SHOWN_DRAFTS);
  const text = [
    `${since} لديك ${readyDraftsAr(ready.length)} للنشر${ready.length > shown.length ? '، أحدثها' : ''}:`,
    ...shown.map((d) => `• #${d.id} — ${draftTitle(d)}`),
    'افتح إحداها وانشرها، أو اطلب موضوعاً جديداً.',
  ].join('\n');
  await sendMessage(ctx.env, ctx.chatId, text, {
    inline_keyboard: [shown.map((d) => button(`عرض #${d.id}`, CB.show(d.id))), planRow],
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

/**
 * الخطة الأسبوعية (SPEC §9): 3 موضوعات مقترحة لكل منها زر «صُغها».
 * تُحدَّث لقطة المقاييس أولاً إن كانت أقدم من أسبوع، وفشلها لا يوقف الخطة.
 * ثم يُبحث عن أحداث الأسبوع ليُبنى عليها اقتراح أو اثنان؛ فشل البحث لا يوقف الخطة بل يُذكر في آخرها.
 */
async function weeklyPlan(ctx: Ctx): Promise<string[]> {
  try {
    const snapshot = await loadSnapshot(ctx.env.DB);
    if (!snapshot || daysBetween(parseUtc(snapshot.at), new Date()) >= SNAPSHOT_MAX_AGE_DAYS) {
      await saveSnapshot(ctx.env.DB, await collectPerformance(ctx));
    }
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'snapshot_refresh_failed', err: errorSummary(err) }));
  }
  let events: EventDigest | null = null;
  let note = '';
  try {
    events = await researchEvents(ctx, SUNDAY_EVENT_DAYS, ctx.deadline - PLAN_RESERVE_MS);
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'events_failed', err: errorSummary(err) }));
    note = `\n\n⚠️ لم أستطع البحث عن أحداث الأسبوع هذه المرة: ${eventsErrorMessage(err)}`;
  }
  const plan = await generatePlan(ctx, '📅 خطة الأسبوع — اقتراحات للنشر:', events);
  await sendMessage(ctx.env, ctx.chatId, plan.text + note, plan.keyboard);
  return [];
}

/** نشرة الأربعاء (طلب المالك): اقتراحات من أحداث الأيام الأخيرة وحدها، أو سطر يقول إنه لا جديد. */
async function midweekEvents(ctx: Ctx): Promise<string[]> {
  let events: EventDigest | null;
  try {
    events = await researchEvents(ctx, MIDWEEK_EVENT_DAYS, ctx.deadline - PLAN_RESERVE_MS);
  } catch (err) {
    return [`البحث عن الأحداث: ${eventsErrorMessage(err)}`];
  }
  const plan = events ? await generateEventsPlan(ctx, events) : null;
  if (!plan) {
    await sendMessage(ctx.env, ctx.chatId, '📰 لا أحداث جديدة مهمة منذ الأحد تستحق منشوراً.');
    return [];
  }
  await sendMessage(ctx.env, ctx.chatId, plan.text, plan.keyboard);
  return [];
}

/** تقرير الأداء الأسبوعي (SPEC §9). */
async function weeklyReport(ctx: Ctx): Promise<string[]> {
  await sendMessage(ctx.env, ctx.chatId, await buildReport(ctx));
  return [];
}

interface CronTask {
  name: string;
  run: (ctx: Ctx) => Promise<string[]>;
  /** مهلة المهمة؛ الافتراض CRON_BUDGET_MS. */
  budgetMs?: number;
}

const TASKS: Record<string, CronTask> = {
  [CRON_DAILY]: { name: 'المتابعة اليومية', run: daily },
  [CRON_WEEKLY_PLAN]: { name: 'الخطة الأسبوعية', run: weeklyPlan, budgetMs: EVENTS_TASK_BUDGET_MS },
  [CRON_MIDWEEK_EVENTS]: { name: 'نشرة الأحداث', run: midweekEvents, budgetMs: EVENTS_TASK_BUDGET_MS },
  [CRON_WEEKLY_REPORT]: { name: 'تقرير الأداء الأسبوعي', run: weeklyReport },
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
  const ctx = makeCtx(env, Number(owner), task.budgetMs ?? CRON_BUDGET_MS);
  let failures: string[];
  try {
    await ensureSchema(env.DB);
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
