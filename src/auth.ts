// التحقق من المصدر والمستخدم (SPEC §4.1 و§4.2).

import { toBase64 } from './encoding.ts';
import type { Env } from './env.ts';
import type { TgUpdate } from './telegram.ts';

/**
 * سر ترويسة الـ webhook: TELEGRAM_WEBHOOK_SECRET إن ضُبط، وإلا يُشتق من توكن البوت (HMAC-SHA256)،
 * فلا يحتاج المالك إلى توليد سر وحفظه. ترميز base64url يطابق الأحرف المسموحة في تيليجرام (A-Z a-z 0-9 _ -).
 * من يملك التوكن يملك البوت أصلاً، فالاشتقاق منه لا يضعف الحماية.
 */
export async function webhookSecret(env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_WEBHOOK_SECRET'>): Promise<string | null> {
  const explicit = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (explicit) return explicit;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode('social-bot:telegram-webhook-secret'));
  return toBase64(mac).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** مقارنة ثابتة الزمن لترويسة X-Telegram-Bot-Api-Secret-Token. */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * يعيد محادثة المالك إن كان التحديث منه في محادثة خاصة، وإلا null فيُتجاهل بصمت.
 * أنواع التحديثات الأخرى (كالرسائل المعدّلة ومنشورات القنوات) تُتجاهل.
 */
export function ownerChat(update: TgUpdate, owner: string | null): number | null {
  if (!owner) return null;
  const msg = update.message;
  if (msg) {
    if (msg.chat.type !== 'private' || String(msg.from?.id) !== owner || String(msg.chat.id) !== owner) return null;
    return msg.chat.id;
  }
  const cq = update.callback_query;
  if (cq) {
    if (String(cq.from.id) !== owner) return null;
    const chat = cq.message?.chat;
    if (chat && (chat.type !== 'private' || String(chat.id) !== owner)) return null;
    return Number(owner);
  }
  return null;
}
