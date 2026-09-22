// الرسائل الصوتية (SPEC §12 المرحلة 2): تفريغ إلى نص بـ Whisper في Workers AI، ثم حفظه فكرةً مصدرها voice.
// الخيار وتكلفته في NOTES.md القسم 6، وقد وافق عليه المالك.

import { PILLARS } from './content.ts';
import type { Ctx } from './context.ts';
import { toBase64 } from './encoding.ts';
import { getJsonState, setState } from './db.ts';
import type { Env } from './env.ts';
import { saveIdea } from './ideas.ts';
import { CB, retryKeyboard } from './preview.ts';
import { downloadFile, editMessageText, sendMessage, TelegramError, type TgAudioFile } from './telegram.ts';
import { truncate } from './text.ts';

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_SECONDS = 5 * 60;
const MAX_BYTES = 20 * 1024 * 1024; // حد getFile في Bot API
const LAST_VOICE_KEY = 'last_voice';
const TRANSCRIPT_PREVIEW_CHARS = 2500;

export class TranscriptionError extends Error {}

export function whisperPrompt(pillars: string[]): string {
  const topics = pillars.length ? pillars.join('، ') : 'الحوكمة والتخطيط الاستراتيجي والقطاع غير الربحي';
  return `فكرة منشور مهني باللغة العربية. الموضوعات: ${topics}.`;
}

/** تفريغ بالعربية عبر ربط AI. يعيد النص بعد التشذيب (قد يكون فارغاً إن لم يُتعرَّف على كلام). */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  let result: { text?: unknown } | null;
  try {
    result = (await env.AI.run(WHISPER_MODEL, {
      audio: toBase64(audio),
      task: 'transcribe',
      language: 'ar',
      vad_filter: true,
      initial_prompt: whisperPrompt(PILLARS),
    })) as { text?: unknown } | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ evt: 'whisper_failed', err: msg.slice(0, 160) }));
    throw new TranscriptionError(/neuron|allocation|quota/i.test(msg) ? 'quota' : 'failed');
  }
  return typeof result?.text === 'string' ? result.text.trim() : '';
}

function failureText(err: unknown): string {
  if (err instanceof TranscriptionError && err.message === 'quota') {
    return 'استُنفدت حصة Workers AI اليومية. أعد المحاولة غداً أو أرسل الفكرة نصاً.';
  }
  if (err instanceof TelegramError) return 'تعذّر تنزيل الرسالة الصوتية من تيليجرام.';
  return 'تعذّر تفريغ الرسالة الصوتية.';
}

/** رسالة صوتية ← تنزيل ← تفريغ ← فكرة (مصدرها voice) مصنّفة، مع عرض النص المفرّغ للتحقق منه. */
export async function handleVoice(ctx: Ctx, file: TgAudioFile): Promise<void> {
  const { env } = ctx;
  if ((file.duration ?? 0) > MAX_SECONDS) {
    await sendMessage(env, ctx.chatId, 'الرسالة الصوتية أطول من 5 دقائق. قسّمها إلى رسائل أقصر أو أرسل الفكرة نصاً.');
    return;
  }
  if ((file.file_size ?? 0) > MAX_BYTES) {
    await sendMessage(env, ctx.chatId, 'الملف الصوتي أكبر من 20MB (حد تيليجرام للبوتات).');
    return;
  }
  // نحفظ مرجع الرسالة ليعمل زر «أعد المحاولة» (معرّف الملف أطول من حد بيانات الزر)
  await setState(env.DB, LAST_VOICE_KEY, JSON.stringify(file));
  const progress = await sendMessage(env, ctx.chatId, '🎙 أفرّغ الرسالة الصوتية…');
  let text: string;
  try {
    const { bytes } = await downloadFile(env, file.file_id);
    text = await transcribe(env, bytes);
  } catch (err) {
    await editMessageText(env, ctx.chatId, progress.message_id, `❌ ${failureText(err)}`, retryKeyboard(CB.retry('v', 0)));
    return;
  }
  if (!text) {
    await editMessageText(env, ctx.chatId, progress.message_id, 'لم أتعرّف على كلام في الرسالة. أعد التسجيل أو أرسل الفكرة نصاً.');
    return;
  }
  await saveIdea(ctx, text, 'voice', {
    editMessageId: progress.message_id,
    extra: `🎙 النص المفرّغ:\n«${truncate(text, TRANSCRIPT_PREVIEW_CHARS)}»`,
  });
}

/** زر «أعد المحاولة» بعد فشل التفريغ. */
export async function retryLastVoice(ctx: Ctx): Promise<void> {
  const file = await getJsonState<TgAudioFile>(ctx.env.DB, LAST_VOICE_KEY);
  if (!file?.file_id) {
    await sendMessage(ctx.env, ctx.chatId, 'لم أجد الرسالة الصوتية. أرسلها من جديد.');
    return;
  }
  await handleVoice(ctx, file);
}
