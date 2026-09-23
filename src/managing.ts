// إدارة المنشور بعد إنشائه في SocialAPI: تغيير موعد المجدول وإلغاؤه، وإعادة محاولة ما فشل من المنشور الجزئي،
// والتحقق من حالة منشور قيد النشر. كل تغيير يمر بضغطة «تأكيد» من المالك (SPEC §13).
// إلغاء الجدولة يستخدم DELETE، ووافق عليه المالك بالضوابط الموثقة في NOTES.md (القسم 8).

import type { Ctx } from './context.ts';
import { remaining, sleep } from './context.ts';
import { claimDraft, getDraft, setScheduledAt, unscheduleDraft, updateDraft, type Draft } from './db.ts';
import { isDryRun } from './env.ts';
import { CB, confirmKeyboard, previewKeyboard, rescheduleKeyboard } from './preview.ts';
import {
  applyOutcome,
  creditText,
  fetchCredits,
  markPostMissing,
  MIN_SCHEDULE_LEAD_MS,
  moveButtons,
  postFingerprint,
} from './publishing.ts';
import {
  deletePost,
  describeTargetError,
  getPost,
  platformName,
  reschedulePost,
  retryPost,
  SocialApiError,
  socialApiErrorMessage,
  type Post,
  type PostStatus,
} from './socialapi.ts';
import { editKeyboard, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';
import { formatRiyadh, parseUtc, scheduleOptions, toRfc3339, toSqlUtc } from './time.ts';

/**
 * لا تغيير ولا إلغاء لمنشور يحين موعده خلال هذه المدة: هامش أمان حتى لا يبدأ النشر أثناء التنفيذ،
 * لأن DELETE على منشور نُشر يحذفه من المنصات.
 */
export const CHANGE_MIN_LEAD_MS = 15 * 60_000;

const RETRY_POLL_ATTEMPTS = 3;
const RETRY_POLL_INTERVAL_MS = 5_000;

const STALE = 'لم يعد هذا التأكيد صالحاً: تغيّرت حالة المسودة أو موعدها. افتحها من /queue من جديد.';
const DRY_RUN_RETRY = '🧪 وضع التجربة مفعّل: إعادة المحاولة تنشر فعلياً، لذلك لا تعمل فيه.';

const STATUS_AR: Record<PostStatus, string> = {
  draft: 'مسودة',
  scheduled: 'مجدول',
  publishing: 'قيد النشر',
  published: 'منشور',
  partial: 'منشور جزئياً',
  failed: 'فشل نشره',
  cancelled: 'ملغى',
};

const statusAr = (s: string) => STATUS_AR[s as PostStatus] ?? s;
const isNotFound = (err: unknown) => err instanceof SocialApiError && err.status === 404;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- الضوابط (دوال خالصة تُختبر وحدها) ----------

/** سبب رفض تغيير موعد مسودة مجدولة أو إلغائها، أو null إن كان مسموحاً. */
export function scheduledRefusal(d: Draft, now = Date.now()): string | null {
  if (d.status !== 'scheduled' || !d.socialapi_post_id) return 'المسودة ليست مجدولة الآن.';
  if (!d.scheduled_at) return 'موعد هذا المنشور غير معروف هنا. راجعه من لوحة SocialAPI.';
  if (parseUtc(d.scheduled_at).getTime() - now <= CHANGE_MIN_LEAD_MS) {
    return 'اقترب موعد النشر (أقل من 15 دقيقة)، فلا يمكن تغييره أو إلغاؤه الآن.';
  }
  return null;
}

/**
 * التحقق من المصدر مباشرة قبل DELETE: يُحذف المنشور فقط إن كان في SocialAPI مجدولاً،
 * وموعده بعد أكثر من 15 دقيقة، ولم يبدأ نشر أي جزء منه.
 */
export function cancelRefusal(post: Post, now = Date.now()): string | null {
  if (post.status !== 'scheduled') return `حالة المنشور في SocialAPI الآن «${statusAr(post.status)}» وليست «مجدول».`;
  const at = validDate(post.scheduled_at);
  if (!at) return 'لم يحدد SocialAPI موعد المنشور.';
  if (at.getTime() - now <= CHANGE_MIN_LEAD_MS) return 'اقترب موعد النشر (أقل من 15 دقيقة).';
  if ((post.targets ?? []).some((t) => t.status === 'published' || t.status === 'publishing')) {
    return 'بدأ نشر جزء من المنشور.';
  }
  return null;
}

// ---------- تغيير الموعد (PATCH، مجاني) ----------

/** «🕒 غيّر الموعد»: خيارات الموعد الجديد مكان أزرار الرسالة. */
export async function showRescheduleOptions(ctx: Ctx, d: Draft, messageId: number): Promise<void> {
  await editKeyboard(ctx.env, ctx.chatId, messageId, rescheduleKeyboard(d, scheduleOptions(new Date())));
}

/** بعد اختيار الموعد الجديد: تأكيد أخير (SPEC §13). */
export async function requestReschedule(ctx: Ctx, d: Draft, at: Date): Promise<void> {
  if (at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    await sendMessage(ctx.env, ctx.chatId, 'فات هذا الموعد أو اقترب كثيراً. اختر موعداً آخر.');
    return;
  }
  const from = d.scheduled_at ? formatRiyadh(parseUtc(d.scheduled_at)) : 'غير معروف';
  const text = [
    `تأكيد تغيير موعد المسودة #${d.id}؟`,
    `من: ${from}`,
    `إلى: ${formatRiyadh(at)} (بتوقيت الرياض)`,
    'تغيير الموعد لا يستهلك رصيداً.',
  ].join('\n');
  await sendMessage(ctx.env, ctx.chatId, text, confirmKeyboard(CB.confirmReschedule(d.id, postFingerprint(d), unix(at)), d.id));
}

export async function confirmReschedule(
  ctx: Ctx,
  draftId: number,
  pfp: string,
  at: Date,
  confirmMessageId: number,
): Promise<void> {
  const { env } = ctx;
  const say = (text: string, keyboard?: InlineKeyboard) => editMessageText(env, ctx.chatId, confirmMessageId, text, keyboard);

  const d = await getDraft(env.DB, draftId);
  if (!d || postFingerprint(d) !== pfp) {
    await say(STALE);
    return;
  }
  const refusal = scheduledRefusal(d);
  if (refusal) {
    await say(refusal);
    return;
  }
  if (at.getTime() - Date.now() < MIN_SCHEDULE_LEAD_MS) {
    await say('فات الموعد المختار أو اقترب كثيراً. اختر موعداً آخر.');
    return;
  }
  const postId = d.socialapi_post_id ?? '';
  await say('⏳ أغيّر الموعد…');
  let post: Post;
  try {
    post = await reschedulePost(env, postId, toRfc3339(at));
  } catch (err) {
    console.error(JSON.stringify({ evt: 'reschedule_failed', draft: d.id, code: err instanceof SocialApiError ? err.code : 'unknown' }));
    if (isNotFound(err)) {
      await say('لم يتغيّر الموعد: المنشور لم يعد موجوداً في SocialAPI.');
      await markPostMissing(ctx, d.id);
    } else if (err instanceof SocialApiError && err.status === 409) {
      // بدأ النشر أو تغيّرت الحالة في SocialAPI: نزامن الحالة المحلية ونعرضها
      await say(`لم يتغيّر الموعد: ${socialApiErrorMessage(err)}`);
      await syncFromRemote(ctx, d.id, postId);
    } else {
      await say(`تعذّر تغيير الموعد: ${socialApiErrorMessage(err)}`);
    }
    return;
  }
  if (post.status !== 'scheduled') {
    await applyOutcome(ctx, d.id, post, confirmMessageId);
    return;
  }
  const newAt = validDate(post.scheduled_at) ?? at;
  await setScheduledAt(env.DB, d.id, postId, toSqlUtc(newAt));
  await showWithButtons(ctx, d.id, confirmMessageId, `🕒 تغيّر موعد المسودة #${d.id} إلى ${formatRiyadh(newAt)} بتوقيت الرياض.`);
}

// ---------- إلغاء الجدولة (DELETE بالضوابط) ----------

export async function requestCancel(ctx: Ctx, d: Draft): Promise<void> {
  const when = d.scheduled_at ? formatRiyadh(parseUtc(d.scheduled_at)) : 'غير معروف';
  const text = [
    `تأكيد إلغاء جدولة المسودة #${d.id} (موعدها ${when} بتوقيت الرياض)؟`,
    'سيُحذف المنشور المجدول من SocialAPI فلا يُنشر، وتعود المسودة معلّقة يمكنك نشرها أو جدولتها لاحقاً.',
  ].join('\n');
  await sendMessage(ctx.env, ctx.chatId, text, confirmKeyboard(CB.confirmCancel(d.id, postFingerprint(d)), d.id));
}

export async function confirmCancel(ctx: Ctx, draftId: number, pfp: string, confirmMessageId: number): Promise<void> {
  const { env } = ctx;
  const say = (text: string, keyboard?: InlineKeyboard) => editMessageText(env, ctx.chatId, confirmMessageId, text, keyboard);

  const d = await getDraft(env.DB, draftId);
  if (!d || postFingerprint(d) !== pfp) {
    await say(STALE);
    return;
  }
  const refusal = scheduledRefusal(d);
  if (refusal) {
    await say(refusal);
    return;
  }
  const postId = d.socialapi_post_id ?? '';
  const done = async (headline: string) => {
    await unscheduleDraft(env.DB, d.id, postId);
    await showWithButtons(ctx, d.id, confirmMessageId, `${headline}\nعادت المسودة #${d.id} معلّقة: يمكنك نشرها أو جدولتها من جديد.`);
  };

  // 1) التحقق من SocialAPI نفسه قبل الحذف مباشرة، لا من السجل المحلي وحده
  await say('⏳ أتحقق من حالة المنشور في SocialAPI…');
  let remote: Post;
  try {
    remote = await getPost(env, postId);
  } catch (err) {
    if (isNotFound(err)) {
      await done('ℹ️ المنشور لم يعد موجوداً في SocialAPI، فلن يُنشر.');
      return;
    }
    await say(`لم يُلغَ شيء: تعذّر التحقق من حالة المنشور. ${socialApiErrorMessage(err)}`);
    return;
  }
  const remoteRefusal = cancelRefusal(remote);
  if (remoteRefusal) {
    await say(`لم يُلغَ شيء: ${remoteRefusal}`);
    if (remote.status !== 'scheduled') {
      await applyOutcome(ctx, d.id, remote);
    } else {
      // قد يكون الموعد تغيّر من لوحة SocialAPI: نحدّث السجل المحلي به
      const at = validDate(remote.scheduled_at);
      if (at) await setScheduledAt(env.DB, d.id, postId, toSqlUtc(at));
    }
    return;
  }

  // 2) الحذف، ثم التأكد منه: المنشور المحذوف يرد 404
  let deleteError: unknown = null;
  try {
    await deletePost(env, postId);
  } catch (err) {
    if (!isNotFound(err)) deleteError = err;
  }
  let after: Post;
  try {
    after = await getPost(env, postId);
  } catch (err) {
    if (isNotFound(err)) {
      console.log(JSON.stringify({ evt: 'schedule_cancelled', draft: d.id }));
      await done(`🚫 أُلغيت جدولة المسودة #${d.id}، ولن يُنشر شيء.`);
      return;
    }
    await say('⚠️ لم أتمكن من التأكد من إلغاء الجدولة. راجع المنشور في لوحة SocialAPI.');
    return;
  }
  // رسائل الأخطاء جمل تامة تنتهي بنقطة
  const reason = deleteError ? socialApiErrorMessage(deleteError).replace(/\.$/, '') : 'لم يؤكد SocialAPI الحذف';
  console.error(JSON.stringify({ evt: 'cancel_not_confirmed', draft: d.id, status: after.status }));
  await say(`⚠️ لم تُلغَ الجدولة: ${reason}. حالة المنشور الآن «${statusAr(after.status)}».`);
  if (after.status !== 'scheduled') await applyOutcome(ctx, d.id, after);
}

// ---------- إعادة محاولة المنشور الجزئي (رصيد واحد) ----------

export async function requestRetry(ctx: Ctx, d: Draft): Promise<void> {
  const { env } = ctx;
  if (isDryRun(env)) {
    await sendMessage(env, ctx.chatId, DRY_RUN_RETRY);
    return;
  }
  const postId = d.socialapi_post_id ?? '';
  let post: Post;
  try {
    post = await getPost(env, postId);
  } catch (err) {
    if (isNotFound(err)) await markPostMissing(ctx, d.id);
    else await sendMessage(env, ctx.chatId, `تعذّر جلب حالة المنشور: ${socialApiErrorMessage(err)}`);
    return;
  }
  if (post.status !== 'partial') {
    // تغيّرت الحالة في SocialAPI (أُعيدت المحاولة من اللوحة مثلاً): نزامنها ونعرضها
    await applyOutcome(ctx, d.id, post);
    return;
  }
  const credits = await fetchCredits(env);
  if (!credits.unlimited && credits.remaining === 0) {
    await sendMessage(env, ctx.chatId, '⛔️ لا يمكن إعادة المحاولة: نفد رصيد منشورات هذا الشهر في SocialAPI (المتبقي 0).');
    return;
  }
  const failed = (post.targets ?? []).filter((t) => t.status === 'failed');
  const where = failed.length ? failed.map((t) => platformName(t.platform)).join(' و') : 'الجزء الفاشل';
  const lines = [
    `تأكيد إعادة محاولة النشر على ${where} للمسودة #${d.id}؟ (${creditText(credits)})`,
    'تعيد SocialAPI محاولة الجزء الفاشل وحده، وتستهلك منشوراً واحداً من الرصيد.',
    ...failed.map((t) => `سبب الفشل السابق في ${platformName(t.platform)}: ${describeTargetError(t)}`),
  ];
  const r = credits.remaining;
  if (!credits.unlimited && r !== null && r <= 2) lines.push('⚠️ تنبيه: رصيد الشهر يوشك على النفاد.');
  await sendMessage(env, ctx.chatId, lines.join('\n'), confirmKeyboard(CB.confirmRetry(d.id, postFingerprint(d)), d.id));
}

export async function confirmRetry(ctx: Ctx, draftId: number, pfp: string, confirmMessageId: number): Promise<void> {
  const { env } = ctx;
  const db = env.DB;
  const say = (text: string, keyboard?: InlineKeyboard) => editMessageText(env, ctx.chatId, confirmMessageId, text, keyboard);

  const d = await getDraft(db, draftId);
  if (!d || d.status !== 'partial' || !d.socialapi_post_id || postFingerprint(d) !== pfp) {
    await say(STALE);
    return;
  }
  if (isDryRun(env)) {
    await say(DRY_RUN_RETRY);
    return;
  }
  // انتقال ذرّي: ضغطتان على «تأكيد» لا تستهلكان رصيدين
  if (!(await claimDraft(db, d.id, ['partial'], 'publishing'))) {
    await say('يجري تنفيذ هذا الطلب بالفعل أو تغيّرت المسودة.');
    return;
  }
  const postId = d.socialapi_post_id;
  await say('⏳ أعيد محاولة النشر…');
  try {
    await retryPost(env, postId);
  } catch (err) {
    const uncertain = !(err instanceof SocialApiError) || err.status === 0 || err.status >= 500;
    console.error(JSON.stringify({ evt: 'retry_failed', draft: d.id, uncertain, code: err instanceof SocialApiError ? err.code : 'unknown' }));
    if (uncertain) {
      // ربما بدأت إعادة المحاولة فعلاً: تبقى «قيد النشر» لتحسمها المتابعة اليومية أو زر التحقق
      await showWithButtons(
        ctx,
        d.id,
        confirmMessageId,
        '⚠️ لم يصل ردّ مؤكد من SocialAPI، وربما بدأت إعادة المحاولة. اضغط «تحقق من الحالة» بعد قليل.',
      );
      return;
    }
    // رفض صريح (لا رصيد، أو لا شيء يُعاد، أو تغيّرت الحالة): لم يبدأ شيء
    await updateDraft(db, d.id, { status: 'partial' });
    await say(`لم تُعد المحاولة: ${socialApiErrorMessage(err)}`);
    if (err.status === 400 || err.status === 409) await syncFromRemote(ctx, d.id, postId);
    return;
  }

  // النجاح الكامل وحده نتيجة قاطعة؛ بقاء «جزئي» قد يعني أن المحاولة لم تبدأ بعد
  const post = await pollForPublished(ctx, postId);
  if (post?.status === 'published') {
    await applyOutcome(ctx, d.id, post, confirmMessageId);
    return;
  }
  await showWithButtons(
    ctx,
    d.id,
    confirmMessageId,
    `⏳ أُرسلت إعادة المحاولة للمسودة #${d.id} ولم تظهر نتيجتها النهائية بعد. اضغط «تحقق من الحالة» بعد قليل، أو ستبلغك المتابعة اليومية.`,
  );
}

async function pollForPublished(ctx: Ctx, postId: string): Promise<Post | null> {
  let last: Post | null = null;
  for (let i = 0; i < RETRY_POLL_ATTEMPTS; i++) {
    if (remaining(ctx) < RETRY_POLL_INTERVAL_MS + 5_000) break;
    await sleep(RETRY_POLL_INTERVAL_MS);
    try {
      last = await getPost(ctx.env, postId);
      if (last.status === 'published') return last;
    } catch (err) {
      console.warn(JSON.stringify({ evt: 'poll_failed', code: err instanceof SocialApiError ? err.code : 'unknown' }));
    }
  }
  return last;
}

// ---------- التحقق من الحالة ----------

/** «🔄 تحقق من الحالة» لمسودة قيد النشر. يعيد نصاً قصيراً للرد على الضغطة إن لم تتغيّر الحالة. */
export async function checkStatus(ctx: Ctx, d: Draft, messageId: number | null): Promise<string | null> {
  let post: Post;
  try {
    post = await getPost(ctx.env, d.socialapi_post_id ?? '');
  } catch (err) {
    if (isNotFound(err)) {
      await markPostMissing(ctx, d.id);
      return null;
    }
    return `تعذّر جلب الحالة: ${socialApiErrorMessage(err)}`;
  }
  if (post.status === 'publishing') return 'ما زال النشر جارياً. تحقق بعد قليل.';
  await applyOutcome(ctx, d.id, post, messageId ?? undefined);
  return null;
}

// ---------- مساعدات ----------

/** يعرض النص في رسالة التأكيد مع أزرار الحالة الحالية للمسودة، ويجعلها رسالة أزرارها الحيّة. */
async function showWithButtons(ctx: Ctx, draftId: number, messageId: number, text: string): Promise<void> {
  const d = await getDraft(ctx.env.DB, draftId);
  const kb = d ? previewKeyboard(d) : null;
  const keyboard = kb?.inline_keyboard.length ? kb : undefined;
  await editMessageText(ctx.env, ctx.chatId, messageId, text, keyboard);
  if (d && keyboard) await moveButtons(ctx, d, messageId);
}

/** يجلب حالة المنشور ويطبّقها محلياً (رسالة جديدة) إن اختلفت عن الحالة المحلية. */
async function syncFromRemote(ctx: Ctx, draftId: number, postId: string): Promise<void> {
  try {
    const post = await getPost(ctx.env, postId);
    const d = await getDraft(ctx.env.DB, draftId);
    if (d && post.status !== d.status) await applyOutcome(ctx, draftId, post);
  } catch (err) {
    if (isNotFound(err)) await markPostMissing(ctx, draftId);
    else console.warn(JSON.stringify({ evt: 'sync_failed', code: err instanceof SocialApiError ? err.code : 'unknown' }));
  }
}
