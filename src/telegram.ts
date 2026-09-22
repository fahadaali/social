// Telegram Bot API عبر fetch مباشرة (SPEC §2).
// تحذير أمني (SPEC §4): روابط الـ API والملفات تحتوي توكن البوت، فلا تُسجَّل ولا تُمرَّر لأي طرف.

import type { Env } from './env.ts';

const API = 'https://api.telegram.org';
export const MAX_MESSAGE_LENGTH = 4096;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** رسالة صوتية (voice) أو ملف صوتي (audio). */
export interface TgAudioFile {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgAudioFile;
  audio?: TgAudioFile;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage; // قد تكون رسالة قديمة غير متاحة (date = 0)
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };

export class TelegramError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;

  constructor(method: string, code: number, description: string) {
    super(`telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

async function call<T>(env: Env, method: string, payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // لا نمرّر رسالة الخطأ الأصلية تحسباً لاحتوائها على الرابط
    throw new TelegramError(method, 0, err instanceof Error ? err.name : 'network error');
  }
  let data: { ok?: boolean; result?: T; error_code?: number; description?: string };
  try {
    data = await res.json();
  } catch {
    throw new TelegramError(method, res.status, 'invalid response');
  }
  if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, String(data.description ?? ''));
  return data.result as T;
}

const isNotModified = (err: unknown) =>
  err instanceof TelegramError && err.description.includes('message is not modified');

function clip(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : text.slice(0, MAX_MESSAGE_LENGTH - 1) + '…';
}

export function sendMessage(
  env: Env,
  chatId: number | string,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<TgMessage> {
  return call<TgMessage>(env, 'sendMessage', {
    chat_id: chatId,
    text: clip(text),
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

export async function editMessageText(
  env: Env,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await call(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: clip(text),
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    if (!isNotModified(err)) throw err;
  }
}

export async function editKeyboard(
  env: Env,
  chatId: number | string,
  messageId: number,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await call(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
  } catch (err) {
    if (!isNotModified(err)) throw err;
  }
}

/** إزالة الأزرار من رسالة قديمة؛ الفشل هنا غير مهم (قد تكون الرسالة محذوفة أو قديمة جداً). */
export async function clearKeyboard(env: Env, chatId: number | string, messageId: number | null): Promise<void> {
  if (!messageId) return;
  try {
    await editKeyboard(env, chatId, messageId, EMPTY_KEYBOARD);
  } catch (err) {
    console.warn('clear keyboard failed', err instanceof TelegramError ? err.code : 'unknown');
  }
}

export async function answerCallback(env: Env, callbackId: string, text?: string, alert = false): Promise<void> {
  try {
    await call(env, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: alert } : {}),
    });
  } catch (err) {
    // انتهاء مهلة الرد على الضغطة لا يمنع إكمال العملية
    console.warn('answerCallbackQuery failed', err instanceof TelegramError ? err.code : 'unknown');
  }
}

export interface DownloadedFile {
  bytes: ArrayBuffer;
  filePath: string;
}

/** getFile ثم تنزيل البايتات داخل الـ Worker (SPEC §8 الصور). حد تيليجرام للتنزيل 20MB. */
export async function downloadFile(env: Env, fileId: string): Promise<DownloadedFile> {
  const file = await call<{ file_path?: string }>(env, 'getFile', { file_id: fileId });
  if (!file.file_path) throw new TelegramError('getFile', 0, 'file_path missing');
  let res: Response;
  try {
    res = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TelegramError('downloadFile', 0, err instanceof Error ? err.name : 'network error');
  }
  if (!res.ok) throw new TelegramError('downloadFile', res.status, 'download failed');
  return { bytes: await res.arrayBuffer(), filePath: file.file_path };
}

export function button(text: string, data: string): InlineButton {
  return { text, callback_data: data };
}
