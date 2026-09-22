// التحقق من المصدر والمستخدم (SPEC §4.1 و§4.2).

import type { TgUpdate } from './telegram.ts';

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
