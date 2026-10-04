// الحذف النهائي بطلب المالك: مسودة، أو فكرة، أو أفكار البنك كلها، أو المسودات المعلّقة كلها.
// كل حذف يمر بتأكيد صريح. المنشور فعلاً لا يُحذف (يبقى لتقرير الأداء)، والمجدول تُلغى جدولته في SocialAPI أولاً.

import type { Ctx } from './context.ts';
import {
  bankStats,
  clearAwaiting,
  deleteBank,
  deleteDraft,
  deleteIdea,
  deletePendingDrafts,
  deleteState,
  getDraft,
  pendingStats,
  unscheduleDraft,
  type Draft,
} from './db.ts';
import { reviseNotesKey } from './drafting.ts';
import { ideasView } from './ideas.ts';
import { cancelRemoteSchedule, scheduledRefusal } from './managing.ts';
import { CB, deleteIdeaConfirmRow, ideaListRow, previewKeyboard, replaceIdeaRow } from './preview.ts';
import { postFingerprint } from './publishing.ts';
import { button, clearKeyboard, editKeyboard, editMessageText, sendMessage, type InlineKeyboard, type TgMessage } from './telegram.ts';
import { draftsAr, ideasAr } from './text.ts';

/** ردّ على الضغطة (تنبيه أو إشعار قصير). */
export interface DeleteReply {
  text?: string;
  alert?: boolean;
}

const canDelete = (d: Draft) => d.status === 'pending' || d.status === 'failed' || d.status === 'scheduled';

const cancelRow = () => [button('إلغاء', CB.cancelDelete())];

// ---------- مسودة واحدة ----------

/** «❌ احذف» في المعاينة: تتبدّل أزرارها إلى تأكيد الحذف و«تراجع». */
export async function askDeleteDraft(ctx: Ctx, d: Draft, messageId: number): Promise<DeleteReply> {
  if (!canDelete(d)) return { text: 'لا تُحذف المسودة في حالتها الحالية.', alert: true };
  const scheduled = d.status === 'scheduled';
  if (scheduled) {
    const refusal = scheduledRefusal(d);
    if (refusal) return { text: refusal, alert: true };
  }
  await editKeyboard(ctx.env, ctx.chatId, messageId, {
    inline_keyboard: [
      [button(scheduled ? `✅ ألغِ الجدولة واحذف #${d.id}` : `✅ احذف المسودة #${d.id} نهائياً`, CB.confirmDeleteDraft(d.id, postFingerprint(d)))],
      [button('↩️ تراجع', CB.back(d.id))],
    ],
  });
  return {
    text: scheduled
      ? 'ستُلغى الجدولة في SocialAPI ثم تُحذف المسودة. لا يمكن التراجع.'
      : 'تُحذف المسودة نهائياً وتعود فكرتها إلى البنك. لا يمكن التراجع.',
  };
}

export async function confirmDeleteDraft(ctx: Ctx, draftId: number, pfp: string, messageId: number): Promise<DeleteReply> {
  const { env } = ctx;
  const db = env.DB;
  const d = await getDraft(db, draftId);
  if (!d) return { text: 'لم أجد هذه المسودة.', alert: true };
  if (postFingerprint(d) !== pfp || !canDelete(d)) {
    await editKeyboard(env, ctx.chatId, messageId, previewKeyboard(d));
    return { text: 'تغيّرت حالة المسودة فلم تُحذف. راجعها ثم أعد المحاولة.', alert: true };
  }
  const say = (text: string) => editMessageText(env, ctx.chatId, messageId, text);

  let cancelled = false;
  if (d.status === 'scheduled') {
    const refusal = scheduledRefusal(d);
    if (refusal) return { text: refusal, alert: true };
    const result = await cancelRemoteSchedule(ctx, d, say);
    if (!result) return {};
    await unscheduleDraft(db, d.id, d.socialapi_post_id ?? '');
    cancelled = true;
  }

  const r = await deleteDraft(db, d.id);
  if (!r) {
    await say(
      cancelled
        ? `🚫 أُلغيت جدولة المسودة #${d.id} لكنها لم تُحذف لأن حالتها تغيّرت. افتحها من /queue.`
        : `لم تُحذف المسودة #${d.id}: تغيّرت حالتها.`,
    );
    return {};
  }
  await deleteState(db, reviseNotesKey(d.id));
  await clearAwaiting(db);
  const lines = [`🗑 حُذفت المسودة #${d.id} نهائياً.`];
  if (cancelled) lines.push('وأُلغيت جدولتها في SocialAPI، فلن يُنشر شيء.');
  if (r.restoredIdea) lines.push(`عادت الفكرة #${r.restoredIdea} إلى البنك (/ideas).`);
  await say(lines.join('\n'));
  if (d.telegram_message_id && d.telegram_message_id !== messageId) await clearKeyboard(env, ctx.chatId, d.telegram_message_id);
  console.log(JSON.stringify({ evt: 'draft_deleted', draft: d.id, cancelled }));
  return { text: 'حُذفت' };
}

// ---------- فكرة واحدة (من رسالة /ideas) ----------

export async function askDeleteIdea(ctx: Ctx, ideaId: number, message: TgMessage | undefined): Promise<DeleteReply> {
  const kb = replaceIdeaRow(message?.reply_markup, ideaId, deleteIdeaConfirmRow(ideaId));
  if (!message || !kb) return { text: 'افتح /ideas من جديد.', alert: true };
  await editKeyboard(ctx.env, ctx.chatId, message.message_id, kb);
  return { text: 'تُحذف الفكرة ومسوداتها غير المنشورة نهائياً. لا يمكن التراجع.' };
}

/** «تراجع» عن حذف فكرة: يعود صفها كما كان. */
export async function keepIdea(ctx: Ctx, ideaId: number, message: TgMessage | undefined): Promise<DeleteReply> {
  const kb = replaceIdeaRow(message?.reply_markup, ideaId, ideaListRow(ideaId));
  if (message && kb) await editKeyboard(ctx.env, ctx.chatId, message.message_id, kb);
  return {};
}

export async function confirmDeleteIdea(ctx: Ctx, ideaId: number, message: TgMessage | undefined): Promise<DeleteReply> {
  const { env } = ctx;
  const r = await deleteIdea(env.DB, ideaId);
  if (!r.deleted) {
    if (r.reason === 'protected') {
      const kb = replaceIdeaRow(message?.reply_markup, ideaId, ideaListRow(ideaId));
      if (message && kb) await editKeyboard(env, ctx.chatId, message.message_id, kb);
      return { text: `لا تُحذف الفكرة #${ideaId}: لها مسودة مجدولة أو منشورة. احذف المسودة أولاً أو اتركها.`, alert: true };
    }
    // فكرة لم تعد موجودة: يُزال صفها من الرسالة
    const kb = replaceIdeaRow(message?.reply_markup, ideaId, []);
    if (message && kb) await editKeyboard(env, ctx.chatId, message.message_id, { inline_keyboard: kb.inline_keyboard.filter((row) => row.length) });
    return { text: 'لم أجد هذه الفكرة؛ ربما حُذفت من قبل.', alert: true };
  }
  await clearAwaiting(env.DB);
  // تُحدَّث رسالة /ideas نفسها بالقائمة بعد الحذف
  if (message) {
    const view = await ideasView(env.DB);
    await editMessageText(env, ctx.chatId, message.message_id, view.text, view.keyboard);
  }
  console.log(JSON.stringify({ evt: 'idea_deleted', idea: ideaId, drafts: r.drafts }));
  return { text: `🗑 حُذفت الفكرة #${ideaId}${r.drafts ? ` ومعها ${draftsAr(r.drafts)}` : ''}` };
}

// ---------- الحذف الجماعي ----------

export async function askDeleteBank(ctx: Ctx, maxId: number): Promise<void> {
  const { count } = await bankStats(ctx.env.DB, maxId);
  if (count === 0) {
    await sendMessage(ctx.env, ctx.chatId, 'البنك فارغ، فلا شيء يُحذف.');
    return;
  }
  const keyboard: InlineKeyboard = {
    inline_keyboard: [[button(`✅ نعم، احذف ${ideasAr(count)}`, CB.confirmDeleteBank(maxId)), ...cancelRow()]],
  };
  await sendMessage(
    ctx.env,
    ctx.chatId,
    [
      `حذف كل أفكار البنك نهائياً؟ (${ideasAr(count)})`,
      'لا يمكن التراجع عن الحذف. الأفكار المؤرشفة وما صيغت منه مسودات ليست في البنك فلا تُحذف هنا.',
    ].join('\n'),
    keyboard,
  );
}

export async function confirmDeleteBank(ctx: Ctx, maxId: number, messageId: number): Promise<void> {
  const r = await deleteBank(ctx.env.DB, maxId);
  await clearAwaiting(ctx.env.DB);
  const lines = [r.deleted ? `🗑 حُذفت ${ideasAr(r.deleted)} من البنك نهائياً.` : 'لم يُحذف شيء: البنك فارغ.'];
  if (r.skipped) lines.push(`بقيت ${ideasAr(r.skipped)} لأن لها مسودات مجدولة أو منشورة.`);
  await editMessageText(ctx.env, ctx.chatId, messageId, lines.join('\n'));
  console.log(JSON.stringify({ evt: 'bank_deleted', deleted: r.deleted, skipped: r.skipped }));
}

export async function askDeletePending(ctx: Ctx, maxId: number): Promise<void> {
  const { count } = await pendingStats(ctx.env.DB, maxId);
  if (count === 0) {
    await sendMessage(ctx.env, ctx.chatId, 'لا توجد مسودات معلّقة تُحذف.');
    return;
  }
  const keyboard: InlineKeyboard = {
    inline_keyboard: [[button(`✅ نعم، احذف ${draftsAr(count)}`, CB.confirmDeletePending(maxId)), ...cancelRow()]],
  };
  await sendMessage(
    ctx.env,
    ctx.chatId,
    [
      `حذف كل المسودات المعلّقة نهائياً؟ (${draftsAr(count)})`,
      'لا يمكن التراجع عن الحذف، وتعود أفكارها إلى البنك.',
      'المجدولة لا تُحذف هنا: احذفها واحدة واحدة من زر «عرض» في /queue.',
    ].join('\n'),
    keyboard,
  );
}

export async function confirmDeletePending(ctx: Ctx, maxId: number, messageId: number): Promise<void> {
  const r = await deletePendingDrafts(ctx.env.DB, maxId);
  await clearAwaiting(ctx.env.DB);
  const lines = [r.deleted ? `🗑 حُذفت ${draftsAr(r.deleted)} معلّقة نهائياً.` : 'لم يُحذف شيء: لا مسودات معلّقة.'];
  if (r.restored) lines.push(`عادت ${ideasAr(r.restored)} إلى البنك (/ideas).`);
  await editMessageText(ctx.env, ctx.chatId, messageId, lines.join('\n'));
  console.log(JSON.stringify({ evt: 'pending_deleted', deleted: r.deleted }));
}
