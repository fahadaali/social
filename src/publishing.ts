// النشر والجدولة (SPEC §7 و§8). قاعدة غير قابلة للتجاوز: لا نشر ولا جدولة إلا بضغطة «تأكيد» من المالك.
// هذه الوحدة لا تُستدعى إلا من أزرار المالك (callbacks)، ولا يوجد أي مسار آلي للنشر.

import type { Ctx } from './context.ts';
import { remaining, sleep } from './context.ts';
import {
  claimDraft,
  getDraft,
  listDraftsByStatus,
  setIdeaStatus,
  setStateIfNewer,
  updateDraft,
  type Draft,
} from './db.ts';
import { isDryRun, monthlyPostLimit, PLATFORM_LABEL, type Env, type Platform } from './env.ts';
import { CB, confirmKeyboard, draftKeyboard, isEditable, versionLabel } from './preview.ts';
import {
  buildPostRequest,
  buildValidateRequest,
  ConfigError,
  createPost,
  describeIssue,
  describeTargetError,
  getPost,
  getUsage,
  platformName,
  SocialApiError,
  socialApiErrorMessage,
  validatePost,
  type Post,
  type PublishMode,
  type ValidationIssue,
} from './socialapi.ts';
import { clearKeyboard, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';
import { LINKEDIN_MAX_CHARS, X_MAX_WEIGHTED, xTooLong } from './text.ts';
import { formatRiyadh, parseUtc, toRfc3339, toSqlUtc } from './time.ts';

export type UserMode = { kind: 'now' } | { kind: 'schedule'; at: Date };

const POLL_ATTEMPTS = 3; // SPEC §8.5: حتى 3 مرات بفاصل 5 ثوانٍ
const POLL_INTERVAL_MS = 5_000;
const MIN_SCHEDULE_LEAD_MS = 5 * 60_000;
const TERMINAL: ReadonlySet<string> = new Set(['published', 'partial', 'failed', 'cancelled']);

export const LAST_PUBLISHED_KEY = 'last_published_at';

// ---------- بصمة المحتوى القابل للنشر ----------

/**
 * بصمة قصيرة للنسخة والمنصات والصورة تُضمَّن في زر «تأكيد»،
 * فإن تغيّر شيء بعد عرض التأكيد يُرفض الزر القديم ولا يُنشر محتوى لم يره المالك.
 */
export function fingerprint(d: Pick<Draft, 'revision' | 'platforms' | 'media_id'>): string {
  const input = `${d.revision}|${[...d.platforms].sort().join(',')}|${d.media_id ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------- الرصيد ----------

interface Credits {
  unlimited: boolean;
  /** null = تعذّر الجلب */
  remaining: number | null;
  periodEnd?: string | undefined;
}

async function fetchCredits(env: Env): Promise<Credits> {
  try {
    const u = await getUsage(env);
    const limit = typeof u.posts_limit === 'number' ? u.posts_limit : monthlyPostLimit(env);
    if (limit === -1) return { unlimited: true, remaining: null, periodEnd: u.period_end };
    const used = typeof u.posts_used === 'number' ? u.posts_used : 0;
    return { unlimited: false, remaining: Math.max(0, limit - used), periodEnd: u.period_end };
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'usage_failed', code: err instanceof SocialApiError ? err.code : 'unknown' }));
    return { unlimited: false, remaining: null };
  }
}

function creditText(c: Credits): string {
  if (c.unlimited) return 'رصيد الخطة غير محدود';
  if (c.remaining === null) return 'تعذّر جلب الرصيد المتبقي';
  return `المتبقي من رصيد الشهر: ${c.remaining}`;
}

export function platformsText(platforms: Platform[]): string {
  return platforms.map((p) => PLATFORM_LABEL[p]).join(' و');
}

const bullet = (issues: ValidationIssue[]) => issues.map((i) => `• ${describeIssue(i)}`).join('\n');

// ---------- الفحص قبل التأكيد ----------

type Precheck =
  | { ok: true; credits: Credits; warnings: ValidationIssue[] }
  | { ok: false; message: string };

function apiMode(env: Env, mode: UserMode): PublishMode {
  if (isDryRun(env)) return { kind: 'draft' };
  return mode.kind === 'now' ? { kind: 'now' } : { kind: 'schedule', at: toRfc3339(mode.at) };
}

/** فحوص محلية + حارس الرصيد (SPEC §8.6) + مسار التحقق (SPEC §8.1). */
async function precheck(ctx: Ctx, d: Draft, mode: UserMode): Promise<Precheck> {
  const { env } = ctx;
  if (d.platforms.length === 0) {
    return { ok: false, message: 'لم تُفعَّل أي منصة لهذه المسودة. فعّل X أو LinkedIn من الأزرار أولاً.' };
  }
  if (d.platforms.includes('x')) {
    const long = xTooLong(d.x_segments);
    if (long.length) {
      return { ok: false, message: `التغريدات ${long.join('، ')} أطول من حد X (${X_MAX_WEIGHTED}). عدّل المسودة أولاً.` };
    }
  }
  if (d.platforms.includes('linkedin') && d.linkedin_text.length > LINKEDIN_MAX_CHARS) {
    return { ok: false, message: `نص لينكدن أطول من ${LINKEDIN_MAX_CHARS} حرف. عدّل المسودة أولاً.` };
  }
  let post;
  try {
    post = buildPostRequest(env, d, apiMode(env, mode));
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, message: err.message };
    throw err;
  }

  const credits = await fetchCredits(env);
  if (!isDryRun(env) && !credits.unlimited && credits.remaining === 0) {
    const renew = credits.periodEnd ? ` يتجدد الرصيد في ${formatRiyadh(new Date(credits.periodEnd))}.` : '';
    return { ok: false, message: `⛔️ لا يمكن النشر: نفد رصيد منشورات هذا الشهر في SocialAPI (المتبقي 0).${renew}` };
  }

  try {
    const scheduledAt = mode.kind === 'schedule' ? toRfc3339(mode.at) : undefined;
    const v = await validatePost(env, buildValidateRequest(post, scheduledAt));
    if (!v.valid || v.errors.length) {
      return {
        ok: false,
        message: `❌ لن يُنشر — أظهر التحقق أخطاء:\n${v.errors.length ? bullet(v.errors) : '• لم تُحدَّد تفاصيل الخطأ'}`,
      };
    }
    return { ok: true, credits, warnings: v.warnings };
  } catch (err) {
    return { ok: false, message: `تعذّر التحقق من المنشور: ${socialApiErrorMessage(err)}` };
  }
}

// ---------- طلب التأكيد ----------

/** بعد «انشر الآن» أو اختيار موعد: تأكيد أخير بزرين «تأكيد» و«إلغاء» (SPEC §7). */
export async function requestConfirmation(ctx: Ctx, draftId: number, mode: UserMode): Promise<void> {
  const d = await getDraft(ctx.env.DB, draftId);
  if (!d || !isEditable(d)) {
    await sendMessage(ctx.env, ctx.chatId, `لا يمكن نشر المسودة #${draftId} في حالتها الحالية.`);
    return;
  }
  if (mode.kind === 'schedule' && mode.at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    await sendMessage(ctx.env, ctx.chatId, 'فات هذا الموعد أو اقترب كثيراً. اختر موعداً آخر من زر «🕒 جدول».');
    return;
  }
  const check = await precheck(ctx, d, mode);
  if (!check.ok) {
    await sendMessage(ctx.env, ctx.chatId, check.message);
    return;
  }
  const where = platformsText(d.platforms);
  const credits = creditText(check.credits);
  const lines = [
    mode.kind === 'now'
      ? `تأكيد النشر على ${where}؟ (${credits})`
      : `تأكيد جدولة النشر على ${where} ${formatRiyadh(mode.at)} بتوقيت الرياض؟ (${credits})`,
    `المسودة #${d.id} (${versionLabel(d)}) — منشور واحد يستهلك رصيداً واحداً.`,
  ];
  const r = check.credits.remaining;
  if (!check.credits.unlimited && r !== null && r <= 2) lines.push('⚠️ تنبيه: رصيد الشهر يوشك على النفاد.');
  if (isDryRun(ctx.env)) lines.push('🧪 وضع التجربة مفعّل: سيُحفظ مسودةً في SocialAPI فقط، ولن يُنشر ولن يُستهلك رصيد.');
  if (d.media_id && d.platforms.includes('x')) lines.push('ℹ️ الصورة تُنشر مع لينكدن فقط.');
  if (check.warnings.length) lines.push(`تنبيهات التحقق:\n${bullet(check.warnings)}`);

  const fp = fingerprint(d);
  const data =
    mode.kind === 'now'
      ? CB.confirmNow(d.id, fp)
      : CB.confirmSchedule(d.id, fp, Math.floor(mode.at.getTime() / 1000));
  await sendMessage(ctx.env, ctx.chatId, lines.join('\n'), confirmKeyboard(data, d.id));
}

// ---------- التنفيذ بعد «تأكيد» ----------

async function pollUntilTerminal(ctx: Ctx, post: Post): Promise<Post> {
  let current = post;
  for (let i = 0; i < POLL_ATTEMPTS && !TERMINAL.has(current.status); i++) {
    if (remaining(ctx) < POLL_INTERVAL_MS + 5_000) break;
    await sleep(POLL_INTERVAL_MS);
    try {
      current = await getPost(ctx.env, current.id);
    } catch (err) {
      console.warn(JSON.stringify({ evt: 'poll_failed', code: err instanceof SocialApiError ? err.code : 'unknown' }));
    }
  }
  return current;
}

export async function confirmPublish(
  ctx: Ctx,
  draftId: number,
  fp: string,
  mode: UserMode,
  confirmMessageId: number,
): Promise<void> {
  const { env } = ctx;
  const db = env.DB;
  const say = (text: string, keyboard?: InlineKeyboard) =>
    editMessageText(env, ctx.chatId, confirmMessageId, text, keyboard);

  const before = await getDraft(db, draftId);
  if (!before || !isEditable(before) || fingerprint(before) !== fp) {
    await say('لم يعد هذا التأكيد صالحاً: تغيّرت المسودة أو نُفّذ الطلب من قبل. اضغط «انشر» أو «جدول» من جديد.');
    return;
  }
  if (mode.kind === 'schedule' && mode.at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    await say('فات الموعد المختار أو اقترب كثيراً. اختر موعداً آخر.');
    return;
  }
  // انتقال ذرّي: ضغطتان على «تأكيد» لا تُنشئان منشورين
  if (!(await claimDraft(db, draftId, [before.status], 'publishing', before.revision))) {
    await say('يجري تنفيذ هذا الطلب بالفعل أو تغيّرت المسودة.');
    return;
  }

  const dry = isDryRun(env);
  let createAttempted = false;
  let created: Post | null = null;
  try {
    const post = buildPostRequest(env, before, apiMode(env, mode));
    // التحقق أولاً مباشرة قبل النشر (SPEC §8.1)
    const v = await validatePost(env, buildValidateRequest(post, mode.kind === 'schedule' ? toRfc3339(mode.at) : undefined));
    if (!v.valid || v.errors.length) {
      await updateDraft(db, draftId, { status: 'pending' });
      await say(`❌ لم يُنشر — أظهر التحقق أخطاء:\n${v.errors.length ? bullet(v.errors) : '• لم تُحدَّد تفاصيل الخطأ'}`);
      return;
    }
    await say(dry ? '⏳ أحفظ المسودة في SocialAPI…' : mode.kind === 'now' ? '⏳ جارٍ النشر…' : '⏳ جارٍ الجدولة…');
    createAttempted = true;
    created = await createPost(env, post);
    await updateDraft(db, draftId, { socialapi_post_id: created.id });

    if (dry) {
      // SPEC §8.4: لا نشر في وضع التجربة؛ تبقى المسودة معلّقة ويمكن نشرها لاحقاً بعد إيقافه
      await updateDraft(db, draftId, { status: 'pending' });
      const when = mode.kind === 'schedule' ? `\n(الموعد المختار ${formatRiyadh(mode.at)} لم يُطبَّق في وضع التجربة)` : '';
      await say(`🧪 وضع التجربة: حُفظت كمسودة في SocialAPI ولم تُنشر.\nالمسودة #${draftId} — معرّف SocialAPI: ${created.id}${when}`);
      return;
    }

    await clearKeyboard(env, ctx.chatId, before.telegram_message_id);
    const final = mode.kind === 'now' ? await pollUntilTerminal(ctx, created) : created;
    await applyOutcome(ctx, draftId, final, confirmMessageId);
  } catch (err) {
    if (created) {
      // المنشور أُنشئ فعلاً في SocialAPI وتعثّر ما بعده (تيليجرام أو D1): نحفظ معرّفه وتتولاه المتابعة اليومية
      console.error(JSON.stringify({ evt: 'post_created_followup_failed', draft: draftId, post: created.id }));
      const current = await getDraft(db, draftId);
      if (current?.status === 'publishing') {
        // لم تُسجَّل نتيجة بعد؛ وإلا فقد سجّلتها applyOutcome ولا نغيّرها
        await updateDraft(db, draftId, {
          socialapi_post_id: created.id,
          status: dry ? 'pending' : created.status === 'scheduled' ? 'scheduled' : 'publishing',
          ...(created.scheduled_at ? { scheduled_at: toSqlUtc(new Date(created.scheduled_at)) } : {}),
        });
      }
      await say('⚠️ أُنشئ المنشور في SocialAPI لكن تعذّر إكمال المتابعة هنا. ستتحقق المهمة اليومية من حالته وتبلغك.');
      return;
    }
    // إن لم يصل ردّ مؤكد بعد طلب الإنشاء فقد يكون المنشور أُنشئ: لا نعيده إلى «معلّقة» تلقائياً
    const uncertain = createAttempted && (!(err instanceof SocialApiError) || err.status === 0 || err.status >= 500);
    console.error(
      JSON.stringify({
        evt: 'publish_failed',
        draft: draftId,
        uncertain,
        code: err instanceof SocialApiError ? err.code : err instanceof Error ? err.name : 'unknown',
      }),
    );
    if (uncertain) {
      await updateDraft(db, draftId, { status: 'failed' });
      await say('⚠️ لم يصل ردّ مؤكد من SocialAPI، وقد يكون المنشور أُنشئ فعلاً. راجع لوحة SocialAPI قبل إعادة المحاولة.');
    } else {
      await updateDraft(db, draftId, { status: 'pending' });
      const reason =
        err instanceof ConfigError ? err.message : err instanceof SocialApiError ? socialApiErrorMessage(err) : 'حدث خطأ غير متوقع.';
      await say(`❌ لم يُنشر: ${reason}`);
    }
  }
}

// ---------- تطبيق النتيجة ----------

function targetLines(post: Post): string[] {
  return (post.targets ?? []).map((t) => {
    const name = platformName(t.platform);
    if (t.status === 'published') return `✅ ${name}: ${t.permalink ?? 'نُشر (بلا رابط)'}`;
    if (t.status === 'failed') return `❌ ${name}: ${describeTargetError(t)}`;
    return `⏳ ${name}: ${t.status ?? 'حالة غير معروفة'}`;
  });
}

/**
 * يحدّث D1 بحالة المنشور ويبلغ المالك بالروابط (permalink) أو الخطأ (SPEC §8.5)،
 * ويحدّث last_published_at بعد كل نشر ناجح (SPEC §8.7).
 */
export async function applyOutcome(ctx: Ctx, draftId: number, post: Post, messageId?: number): Promise<void> {
  const db = ctx.env.DB;
  const lines: string[] = [];
  let actionable = false;

  switch (post.status) {
    case 'published':
    case 'partial': {
      const at = post.published_at ? new Date(post.published_at) : new Date();
      const publishedAt = toSqlUtc(Number.isNaN(at.getTime()) ? new Date() : at);
      await updateDraft(db, draftId, { status: post.status, published_at: publishedAt, socialapi_post_id: post.id });
      const d = await getDraft(db, draftId);
      if (d?.idea_id) await setIdeaStatus(db, d.idea_id, 'published');
      await setStateIfNewer(db, LAST_PUBLISHED_KEY, publishedAt);
      lines.push(post.status === 'published' ? `✅ نُشرت المسودة #${draftId}` : `⚠️ نُشرت المسودة #${draftId} جزئياً`);
      lines.push(...targetLines(post));
      break;
    }
    case 'failed':
    case 'cancelled': {
      await updateDraft(db, draftId, { status: 'failed', socialapi_post_id: post.id });
      lines.push(
        post.status === 'failed'
          ? `❌ فشل نشر المسودة #${draftId}`
          : `🚫 أُلغي منشور المسودة #${draftId} من لوحة SocialAPI`,
      );
      lines.push(...targetLines(post));
      actionable = true;
      break;
    }
    case 'scheduled': {
      const at = post.scheduled_at ? new Date(post.scheduled_at) : null;
      const valid = at && !Number.isNaN(at.getTime()) ? at : null;
      await updateDraft(db, draftId, {
        status: 'scheduled',
        socialapi_post_id: post.id,
        scheduled_at: valid ? toSqlUtc(valid) : null,
      });
      lines.push(`🕒 جُدولت المسودة #${draftId}${valid ? ` للنشر ${formatRiyadh(valid)} بتوقيت الرياض` : ''}.`);
      break;
    }
    case 'publishing': {
      await updateDraft(db, draftId, { status: 'publishing', socialapi_post_id: post.id });
      lines.push(`⏳ ما زال نشر المسودة #${draftId} جارياً. ستتابعه المهمة اليومية وتبلغك بالنتيجة.`);
      break;
    }
    case 'draft': {
      await updateDraft(db, draftId, { status: 'pending', socialapi_post_id: post.id });
      lines.push(`ℹ️ حُفظ منشور المسودة #${draftId} مسودةً في SocialAPI ولم يُنشر.`);
      actionable = true;
      break;
    }
  }

  const text = lines.join('\n') || `حالة منشور المسودة #${draftId}: ${post.status}`;
  let keyboard: InlineKeyboard | undefined;
  const draft = actionable ? await getDraft(db, draftId) : null;
  if (draft && isEditable(draft)) keyboard = draftKeyboard(draft);

  let shownId = messageId;
  if (messageId) await editMessageText(ctx.env, ctx.chatId, messageId, text, keyboard);
  else shownId = (await sendMessage(ctx.env, ctx.chatId, text, keyboard)).message_id;

  // عند فشل النشر تنتقل الأزرار إلى رسالة النتيجة ليتمكن المالك من المحاولة مجدداً
  if (draft && keyboard && shownId) {
    if (draft.telegram_message_id && draft.telegram_message_id !== shownId) {
      await clearKeyboard(ctx.env, ctx.chatId, draft.telegram_message_id);
    }
    await updateDraft(db, draftId, { telegram_message_id: shownId });
  }
}

// ---------- المتابعة اليومية (SPEC §9 أ) ----------

/**
 * يتابع المنشورات العالقة في publishing، والمجدولة التي حلّ موعدها،
 * ويبلغ المالك عند وصولها لحالة نهائية. يعيد عدد المسودات التي تغيّرت حالتها.
 */
export async function followUpPosts(ctx: Ctx): Promise<{ changed: number; errors: string[] }> {
  const drafts = await listDraftsByStatus(ctx.env.DB, ['publishing', 'scheduled']);
  let changed = 0;
  const errors: string[] = [];
  for (const d of drafts) {
    if (!d.socialapi_post_id) continue;
    if (d.status === 'scheduled' && d.scheduled_at && parseUtc(d.scheduled_at).getTime() > Date.now()) continue;
    try {
      const post = await getPost(ctx.env, d.socialapi_post_id);
      if (post.status === d.status) continue;
      await applyOutcome(ctx, d.id, post);
      changed++;
    } catch (err) {
      if (err instanceof SocialApiError && err.status === 404) {
        await updateDraft(ctx.env.DB, d.id, { status: 'failed' });
        await sendMessage(ctx.env, ctx.chatId, `⚠️ لم يعد منشور المسودة #${d.id} موجوداً في SocialAPI (ربما حُذف من اللوحة).`);
        changed++;
        continue;
      }
      errors.push(`المسودة #${d.id}: ${socialApiErrorMessage(err)}`);
    }
  }
  return { changed, errors };
}
