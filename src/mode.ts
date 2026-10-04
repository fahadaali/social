// وضع التجربة من البوت نفسه (طلب المالك): /mode يعرض الوضع الحالي ويبدّله، ويُحفظ في جدول state.
// القيمة المحفوظة تتقدم على متغير DRY_RUN في Cloudflare. إن لم تُحفظ قيمة بعد، يبقى المتغير هو المرجع،
// وغيابه يعني وضع التجربة (الافتراض الآمن).

import type { Ctx } from './context.ts';
import { getState, setState, STATE_KEYS } from './db.ts';
import { isDryRun, type Env } from './env.ts';
import { CB } from './preview.ts';
import { button, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';

/** البيئة بعد تطبيق الوضع المحفوظ من البوت، إن وُجد. تُستدعى بعد ensureSchema. */
export async function withSavedMode(env: Env): Promise<Env> {
  if (!env.DB) return env;
  const saved = await getState(env.DB, STATE_KEYS.dryRun);
  return saved === 'true' || saved === 'false' ? { ...env, DRY_RUN: saved } : env;
}

const TEST_TEXT = '🧪 وضع التجربة مفعّل: «تأكيد» يحفظ المنشور مسودةً في SocialAPI، ولا يُنشر ولا يُستهلك رصيد.';
const LIVE_TEXT = '🚀 النشر الفعلي مفعّل: «تأكيد» ينشر على X ولينكدن فعلاً، ويستهلك من رصيد SocialAPI.';

function modeKeyboard(dry: boolean): InlineKeyboard {
  return {
    inline_keyboard: [[dry ? button('🚀 فعّل النشر الفعلي', CB.modeLive()) : button('🧪 ارجع إلى وضع التجربة', CB.modeTest())]],
  };
}

/** /mode: الوضع الحالي وزر التبديل. */
export async function showMode(ctx: Ctx): Promise<void> {
  const dry = isDryRun(ctx.env);
  await sendMessage(ctx.env, ctx.chatId, dry ? TEST_TEXT : LIVE_TEXT, modeKeyboard(dry));
}

/** «فعّل النشر الفعلي»: تأكيد صريح قبل التبديل، لأن بعده يُنشر المحتوى فعلاً. */
export async function requestLiveMode(ctx: Ctx, messageId: number): Promise<void> {
  if (!isDryRun(ctx.env)) {
    await editMessageText(ctx.env, ctx.chatId, messageId, LIVE_TEXT, modeKeyboard(false));
    return;
  }
  await editMessageText(
    ctx.env,
    ctx.chatId,
    messageId,
    [
      'تفعيل النشر الفعلي؟',
      'بعده ينشر زر «تأكيد» على X ولينكدن فعلاً، وكل منشور يستهلك رصيداً واحداً من SocialAPI.',
      'أزرار «تأكيد» التي ظهرت في وضع التجربة لن تعمل بعد التبديل؛ اطلب النشر من جديد.',
    ].join('\n'),
    { inline_keyboard: [[button('✅ نعم، فعّل النشر الفعلي', CB.modeLiveConfirm()), button('إلغاء', CB.modeCancel())]] },
  );
}

/** يحفظ الوضع ويعدّل الرسالة بالنتيجة. */
export async function setMode(ctx: Ctx, dry: boolean, messageId: number): Promise<void> {
  await setState(ctx.env.DB, STATE_KEYS.dryRun, dry ? 'true' : 'false');
  ctx.env = { ...ctx.env, DRY_RUN: dry ? 'true' : 'false' };
  await editMessageText(ctx.env, ctx.chatId, messageId, dry ? TEST_TEXT : LIVE_TEXT, modeKeyboard(dry));
}

/** «إلغاء» في تأكيد التبديل: يبقى الوضع كما هو. */
export async function cancelModeChange(ctx: Ctx, messageId: number): Promise<void> {
  const dry = isDryRun(ctx.env);
  await editMessageText(ctx.env, ctx.chatId, messageId, `أُلغي. ${dry ? TEST_TEXT : LIVE_TEXT}`, modeKeyboard(dry));
}
