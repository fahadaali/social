// أزرار المسودة والتأكيد والاقتراحات (SPEC §7).

import type { Ctx } from '../context.ts';
import {
  claimDraft,
  clearAwaiting,
  getDraft,
  getState,
  setAwaiting,
  setIdeaStatus,
  updateDraft,
  type Draft,
} from '../db.ts';
import { formulateIdea, regenerateDraft, resendPreview, reviseDraft, reviseNotesKey } from '../drafting.ts';
import { PLATFORM_LABEL, type Platform } from '../env.ts';
import { archiveIdea, listIdeas, reclassifyIdea, unarchiveIdea } from '../ideas.ts';
import {
  checkStatus,
  confirmCancel,
  confirmReschedule,
  confirmRetry,
  requestCancel,
  requestReschedule,
  requestRetry,
  scheduledRefusal,
  showRescheduleOptions,
} from '../managing.ts';
import { pickSuggestion, runPlan } from '../planning.ts';
import { runStats } from '../reporting.ts';
import { retryLastVoice } from '../voice.ts';
import {
  CB,
  draftKeyboard,
  isEditable,
  previewKeyboard,
  scheduleKeyboard,
  snapCopyMessages,
  statusLine,
} from '../preview.ts';
import { confirmPublish, requestConfirmation } from '../publishing.ts';
import {
  answerCallback,
  button,
  clearKeyboard,
  editKeyboard,
  editMessageText,
  EMPTY_KEYBOARD,
  sendMessage,
  type TgCallbackQuery,
} from '../telegram.ts';
import { scheduleOptions } from '../time.ts';

const toInt = (s: string | undefined): number | null => (s && /^\d{1,12}$/.test(s) ? Number(s) : null);
// بصمة التأكيد (fingerprint أو postFingerprint في publishing.ts)
const toFp = (s: string | undefined): string | null => (s && /^[0-9a-z]{1,8}$/.test(s) ? s : null);

/** نص «إلغاء» في رسالة تأكيد بحسب حالة المسودة. */
function cancelledText(d: Draft | null): string {
  if (d && isEditable(d)) return 'أُلغي. المسودة ما زالت معلّقة.';
  if (d?.status === 'scheduled') return 'أُلغي. بقي الموعد كما هو.';
  if (d?.status === 'partial') return 'أُلغي. لم تُعد المحاولة.';
  return 'أُلغي.';
}

const cancelKeyboard = { inline_keyboard: [[button('إلغاء', CB.cancelAwaiting())]] };

export async function handleCallback(ctx: Ctx, cq: TgCallbackQuery): Promise<void> {
  const { env } = ctx;
  const db = env.DB;
  const messageId = cq.message?.message_id ?? null;
  const [action, a, b, c] = (cq.data ?? '').split(':');

  let answered = false;
  const answer = async (text?: string, alert = false) => {
    if (answered) return;
    answered = true;
    await answerCallback(env, cq.id, text, alert);
  };

  const load = async (id: number | null): Promise<Draft | null> => {
    const d = id === null ? null : await getDraft(db, id);
    if (!d) await answer('لم أجد هذه المسودة.', true);
    return d;
  };
  const refuse = (d: Draft) =>
    answer(statusLine(d) ?? 'لا يمكن تنفيذ هذا الإجراء على المسودة في حالتها الحالية.', true);

  /** يحمّل مسودة قابلة للتعديل، أو يرد بسبب الرفض في تنبيه. */
  const editable = async (id: number | null): Promise<Draft | null> => {
    const d = await load(id);
    if (d && !isEditable(d)) {
      await refuse(d);
      return null;
    }
    return d;
  };

  /** مسودة مجدولة يمكن تغيير موعدها أو إلغاؤها الآن (قبل الموعد بأكثر من 15 دقيقة). */
  const changeable = async (id: number | null): Promise<Draft | null> => {
    const d = await load(id);
    if (!d) return null;
    if (d.status !== 'scheduled') {
      await refuse(d);
      return null;
    }
    const refusal = scheduledRefusal(d);
    if (refusal) {
      await answer(refusal, true);
      return null;
    }
    return d;
  };

  /** مسودة في حالة بعينها ولها منشور في SocialAPI. */
  const withPost = async (id: number | null, status: Draft['status']): Promise<Draft | null> => {
    const d = await load(id);
    if (d && (d.status !== status || !d.socialapi_post_id)) {
      await refuse(d);
      return null;
    }
    return d;
  };

  try {
    switch (action) {
      // ----- الأفكار -----
      case 'fmt': {
        const ideaId = toInt(a);
        if (ideaId === null) break;
        await answer();
        await formulateIdea(ctx, ideaId);
        break;
      }
      case 'cls': {
        const ideaId = toInt(a);
        if (ideaId === null || messageId === null) break;
        await answer();
        await reclassifyIdea(ctx, ideaId, messageId);
        break;
      }
      case 'arc':
      case 'una': {
        const ideaId = toInt(a);
        if (ideaId === null) break;
        const r = action === 'arc' ? await archiveIdea(ctx, ideaId, cq.message) : await unarchiveIdea(ctx, ideaId, cq.message);
        await answer(r.text, r.alert);
        break;
      }

      // ----- النشر والجدولة -----
      case 'pub': {
        const d = await editable(toInt(a));
        if (!d) break;
        await answer();
        await requestConfirmation(ctx, d.id, { kind: 'now' });
        break;
      }
      case 'sch': {
        const d = await editable(toInt(a));
        if (!d || messageId === null) break;
        await answer();
        await editKeyboard(env, ctx.chatId, messageId, scheduleKeyboard(d, scheduleOptions(new Date())));
        break;
      }
      case 'sat': {
        const d = await editable(toInt(a));
        const unix = toInt(b);
        if (!d || unix === null) break;
        await answer();
        if (messageId !== null) await editKeyboard(env, ctx.chatId, messageId, draftKeyboard(d));
        await requestConfirmation(ctx, d.id, { kind: 'schedule', at: new Date(unix * 1000) });
        break;
      }
      case 'bk': {
        // رجوع من خيارات الموعد إلى أزرار المسودة في حالتها الحالية
        const d = await load(toInt(a));
        if (!d || messageId === null) break;
        await answer();
        await editKeyboard(env, ctx.chatId, messageId, previewKeyboard(d));
        break;
      }
      case 'okn':
      case 'oks': {
        const draftId = toInt(a);
        const fp = toFp(b);
        const unix = action === 'oks' ? toInt(c) : null;
        if (draftId === null || fp === null || messageId === null || (action === 'oks' && unix === null)) break;
        await answer();
        await confirmPublish(
          ctx,
          draftId,
          fp,
          action === 'okn' ? { kind: 'now' } : { kind: 'schedule', at: new Date((unix ?? 0) * 1000) },
          messageId,
        );
        break;
      }
      case 'no': {
        await answer('أُلغي');
        const id = toInt(a);
        const d = id === null ? null : await getDraft(db, id);
        if (messageId !== null) await editMessageText(env, ctx.chatId, messageId, cancelledText(d));
        break;
      }

      // ----- إدارة المنشور بعد إنشائه (managing.ts) -----
      case 'rsc': {
        const d = await changeable(toInt(a));
        if (!d || messageId === null) break;
        await answer();
        await showRescheduleOptions(ctx, d, messageId);
        break;
      }
      case 'rsa': {
        const d = await changeable(toInt(a));
        const unix = toInt(b);
        if (!d || unix === null) break;
        await answer();
        if (messageId !== null) await editKeyboard(env, ctx.chatId, messageId, previewKeyboard(d));
        await requestReschedule(ctx, d, new Date(unix * 1000));
        break;
      }
      case 'rso': {
        const draftId = toInt(a);
        const pfp = toFp(b);
        const unix = toInt(c);
        if (draftId === null || pfp === null || unix === null || messageId === null) break;
        await answer();
        await confirmReschedule(ctx, draftId, pfp, new Date(unix * 1000), messageId);
        break;
      }
      case 'csc': {
        const d = await changeable(toInt(a));
        if (!d) break;
        await answer();
        await requestCancel(ctx, d);
        break;
      }
      case 'cso': {
        const draftId = toInt(a);
        const pfp = toFp(b);
        if (draftId === null || pfp === null || messageId === null) break;
        await answer();
        await confirmCancel(ctx, draftId, pfp, messageId);
        break;
      }
      case 'prt': {
        const d = await withPost(toInt(a), 'partial');
        if (!d) break;
        await answer();
        await requestRetry(ctx, d);
        break;
      }
      case 'pro': {
        const draftId = toInt(a);
        const pfp = toFp(b);
        if (draftId === null || pfp === null || messageId === null) break;
        await answer();
        await confirmRetry(ctx, draftId, pfp, messageId);
        break;
      }
      case 'chk': {
        const d = await withPost(toInt(a), 'publishing');
        if (!d) break;
        const note = await checkStatus(ctx, d, messageId);
        await answer(note ?? undefined);
        break;
      }
      case 'snp': {
        const d = await load(toInt(a));
        if (!d) break;
        if (d.snap_script.length === 0) {
          await answer('لا يوجد سكربت سناب لهذه المسودة.', true);
          break;
        }
        await answer();
        for (const m of snapCopyMessages(d)) await sendMessage(env, ctx.chatId, m.text, undefined, m.entities);
        break;
      }

      // ----- التعديل -----
      case 'edt': {
        const d = await editable(toInt(a));
        if (!d) break;
        await setAwaiting(db, 'edit', d.id);
        await answer();
        await sendMessage(env, ctx.chatId, `✏️ اكتب ملاحظاتك على المسودة #${d.id} وسأعيد صياغتها وفقها.`, cancelKeyboard);
        break;
      }
      case 'rgn': {
        const d = await editable(toInt(a));
        if (!d) break;
        await answer();
        await regenerateDraft(ctx, d.id);
        break;
      }
      case 'img': {
        const d = await editable(toInt(a));
        if (!d) break;
        await setAwaiting(db, 'image', d.id);
        await answer();
        await sendMessage(
          env,
          ctx.chatId,
          `🖼 أرسل صورة التصميم الآن للمسودة #${d.id}.\nللحفاظ على الجودة أرسلها كملف (File) بدل صورة مضغوطة.`,
          cancelKeyboard,
        );
        break;
      }
      case 'tgl': {
        const d = await editable(toInt(a));
        const platform: Platform | null = b === 'x' ? 'x' : b === 'li' ? 'linkedin' : null;
        if (!d || !platform) break;
        const enabled = !d.platforms.includes(platform);
        const platforms = enabled ? [...d.platforms, platform] : d.platforms.filter((p) => p !== platform);
        await updateDraft(db, d.id, { platforms });
        await answer(`${PLATFORM_LABEL[platform]}: ${enabled ? 'مفعّل' : 'موقوف'}`);
        if (messageId !== null) await editKeyboard(env, ctx.chatId, messageId, draftKeyboard({ ...d, platforms }));
        break;
      }
      case 'rej': {
        const d = await editable(toInt(a));
        if (!d) break;
        if (!(await claimDraft(db, d.id, ['pending', 'failed'], 'rejected'))) {
          await answer('تغيّرت حالة المسودة.', true);
          break;
        }
        if (d.idea_id) await setIdeaStatus(db, d.idea_id, 'archived');
        await answer('تم التجاهل');
        if (messageId !== null) await editKeyboard(env, ctx.chatId, messageId, EMPTY_KEYBOARD);
        if (d.telegram_message_id !== messageId) await clearKeyboard(env, ctx.chatId, d.telegram_message_id);
        await sendMessage(env, ctx.chatId, `🗑 تم تجاهل المسودة #${d.id}${d.idea_id ? ` وأُرشفت الفكرة #${d.idea_id}` : ''}.`);
        break;
      }
      case 'cxl': {
        await clearAwaiting(db);
        await answer('أُلغي');
        if (messageId !== null) await editMessageText(env, ctx.chatId, messageId, 'أُلغي الطلب.');
        break;
      }

      // ----- التذكير والخطة -----
      case 'plan': {
        await answer();
        await runPlan(ctx);
        break;
      }
      case 'ideas': {
        await answer();
        await listIdeas(ctx);
        break;
      }
      case 'shw': {
        const id = toInt(a);
        if (id === null) break;
        await answer();
        await resendPreview(ctx, id);
        break;
      }
      case 'ps': {
        const index = toInt(b);
        if (!a || index === null) break;
        await answer();
        await pickSuggestion(ctx, a, index);
        break;
      }

      // ----- أعد المحاولة بعد خطأ من Anthropic (SPEC §11) -----
      case 'rt': {
        const id = toInt(b);
        if (id === null) break;
        await answer();
        if (messageId !== null) await editKeyboard(env, ctx.chatId, messageId, EMPTY_KEYBOARD);
        if (a === 'f') await formulateIdea(ctx, id);
        else if (a === 'g') await regenerateDraft(ctx, id);
        else if (a === 'p') await runPlan(ctx);
        else if (a === 's') await runStats(ctx);
        else if (a === 'v') await retryLastVoice(ctx);
        else if (a === 'e') {
          const notes = await getState(db, reviseNotesKey(id));
          if (notes) await reviseDraft(ctx, id, notes);
          else {
            await setAwaiting(db, 'edit', id);
            await sendMessage(env, ctx.chatId, `✏️ أرسل ملاحظاتك على المسودة #${id} من جديد.`, cancelKeyboard);
          }
        }
        break;
      }
    }
  } finally {
    // كل ضغطة يجب أن يُرد عليها لإيقاف مؤشر التحميل في تيليجرام
    await answer();
  }
}
