// إرفاق الصور (SPEC §8 الصور): أكبر نسخة من photo ← getFile ← تنزيل البايتات داخل الـ Worker
// ← رفعها إلى SocialAPI من الخادم ← حفظ media_id. رابط ملف تيليجرام لا يُرسل لأي طرف (SPEC §4.4).

import type { Ctx } from './context.ts';
import { getDraft, updateDraft } from './db.ts';
import { draftKeyboard, isEditable } from './preview.ts';
import { SocialApiError, socialApiErrorMessage, uploadMedia } from './socialapi.ts';
import { clearKeyboard, downloadFile, editMessageText, sendMessage, TelegramError, type TgMessage } from './telegram.ts';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // حد getFile في Bot API

export interface IncomingImage {
  fileId: string;
  mime: string | null;
  size: number | null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/** الصورة من الرسالة: أكبر نسخة من photo، أو ملف (document) نوعه صورة للحفاظ على الجودة. */
export function pickImage(msg: TgMessage): IncomingImage | null {
  if (msg.photo?.length) {
    const largest = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return { fileId: largest.file_id, mime: 'image/jpeg', size: largest.file_size ?? null };
  }
  const doc = msg.document;
  if (doc?.mime_type?.startsWith('image/')) {
    return { fileId: doc.file_id, mime: doc.mime_type, size: doc.file_size ?? null };
  }
  return null;
}

export async function attachImage(ctx: Ctx, draftId: number, image: IncomingImage): Promise<void> {
  const { env } = ctx;
  const draft = await getDraft(env.DB, draftId);
  if (!draft || !isEditable(draft)) {
    await sendMessage(env, ctx.chatId, `لا يمكن إرفاق صورة بالمسودة #${draftId} في حالتها الحالية.`);
    return;
  }
  if (image.size !== null && image.size > MAX_DOWNLOAD_BYTES) {
    await sendMessage(env, ctx.chatId, 'حجم الصورة أكبر من 20MB (حد تيليجرام للبوتات). أرسل نسخة أصغر.');
    return;
  }
  const progress = await sendMessage(env, ctx.chatId, `⏳ أرفع الصورة للمسودة #${draft.id}…`);
  try {
    const file = await downloadFile(env, image.fileId);
    const extFromPath = /\.([a-z0-9]+)$/i.exec(file.filePath)?.[1]?.toLowerCase();
    const contentType = image.mime ?? (extFromPath ? MIME_BY_EXT[extFromPath] : undefined) ?? 'image/jpeg';
    const ext = EXT_BY_MIME[contentType] ?? extFromPath ?? 'jpg';
    const mediaId = await uploadMedia(env, file.bytes, `draft-${draft.id}.${ext}`, contentType);
    await updateDraft(env.DB, draft.id, { media_id: mediaId });
    const updated = (await getDraft(env.DB, draft.id)) ?? { ...draft, media_id: mediaId };
    await editMessageText(
      env,
      ctx.chatId,
      progress.message_id,
      `✅ أُرفقت الصورة بالمسودة #${draft.id}.\nℹ️ تُنشر مع لينكدن فقط؛ X لا يدعم الصور عبر SocialAPI حالياً.`,
      draftKeyboard(updated),
    );
    await clearKeyboard(env, ctx.chatId, draft.telegram_message_id);
    await updateDraft(env.DB, draft.id, { telegram_message_id: progress.message_id });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'attach_failed',
        draft: draft.id,
        code: err instanceof SocialApiError ? err.code : err instanceof TelegramError ? `tg_${err.code}` : 'unknown',
      }),
    );
    const reason =
      err instanceof SocialApiError
        ? socialApiErrorMessage(err)
        : err instanceof TelegramError
          ? 'تعذّر تنزيل الصورة من تيليجرام.'
          : 'حدث خطأ غير متوقع.';
    await editMessageText(env, ctx.chatId, progress.message_id, `❌ لم تُرفق الصورة: ${reason}`);
  }
}
