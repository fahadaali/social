// الرسائل النصية والأوامر والصور (SPEC §7).

import { exportBackup } from '../backup.ts';
import { PILLARS, VOICE_FILLED } from '../content.ts';
import type { Ctx } from '../context.ts';
import { clearAwaiting, getAwaiting, remindersPaused } from '../db.ts';
import { reviseDraft } from '../drafting.ts';
import { accountId, isDryRun, type Env } from '../env.ts';
import { listIdeas, saveIdea } from '../ideas.ts';
import { attachImage, pickImage } from '../images.ts';
import { BOT_COMMANDS, menuCommand, menuKeyboard } from '../menu.ts';
import { runPlan } from '../planning.ts';
import { runStats } from '../reporting.ts';
import { setRemindersPaused, showQueue, showUsage } from '../status.ts';
import { sendMessage, setChatCommands, TelegramError, type TgMessage } from '../telegram.ts';
import { handleVoice } from '../voice.ts';

const COMMANDS_HELP = `الأوامر:
/ideas — آخر 10 أفكار جديدة، لكل فكرة زرّا «صُغها» و«أرشف»
/plan — اقتراح 3 موضوعات للنشر
/queue — المسودات المعلّقة والمجدولة، لكل منها زر «عرض»
/stats — تقرير الأداء الآن
/usage — رصيد المنشورات المتبقي هذا الشهر في SocialAPI
/pause و /resume — إيقاف تذكيرات الانقطاع واستئنافها
/export — نسخة احتياطية من أفكارك ومسوداتك (ملف JSON)
/help — المساعدة

تلقائياً: متابعة يومية 9 ص، وخطة أسبوعية الأحد 8 ص، وتقرير أداء الخميس 5 م (بتوقيت الرياض).`;

function configWarnings(env: Env): string[] {
  const w: string[] = [];
  if (isDryRun(env)) w.push('🧪 وضع التجربة مفعّل: المنشورات تُحفظ مسودات في SocialAPI ولا تُنشر.');
  if (PILLARS.length === 0) w.push('⚠️ لم تُعبّأ محاور المحتوى في config/pillars.md بعد.');
  if (!VOICE_FILLED) w.push('⚠️ لم يُعبّأ دليل الأسلوب في config/voice.md بعد.');
  if (!accountId(env, 'x')) w.push('⚠️ لم يُضبط SOCIALAPI_X_ACCOUNT_ID.');
  if (!accountId(env, 'linkedin')) w.push('⚠️ لم يُضبط SOCIALAPI_LINKEDIN_ACCOUNT_ID.');
  return w;
}

function welcome(env: Env): string {
  const warnings = configWarnings(env);
  return [
    'أهلاً بك. أنا مساعدك للنشر على X ولينكدن.',
    [
      '• أرسل أي فكرة نصاً أو رسالة صوتية (أو صورة مع تعليق) وسأحفظها في بنك الأفكار وأصنّف محورها.',
      '• اضغط «صُغها الآن» لأجهّز ثريد X ونص لينكدن وسكربت سناب.',
      '• لا يُنشر ولا يُجدول أي شيء إلا بعد ضغطك «تأكيد».',
      '• للوصول السريع: الأزرار أسفل المحادثة، أو زر «القائمة» بجوار خانة الكتابة.',
    ].join('\n'),
    COMMANDS_HELP,
    warnings.join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function help(env: Env): string {
  return [
    'طريقة العمل:',
    [
      '1) أرسل فكرتك نصاً أو رسالة صوتية ← أحفظها (بعد تفريغ الصوت) وأصنّف محورها.',
      '2) «صُغها الآن» ← مسودة فيها ثريد X ونص لينكدن وسكربت سناب.',
      '3) أزرار المسودة: ✅ انشر الآن، 🕒 جدول، ✏️ عدّل (اكتب ملاحظاتك)، 🔁 صياغة جديدة، 🖼 أرفق صورة، 📋 سكربت سناب (للنسخ)، X/LinkedIn لتفعيل المنصات، 🗑 تجاهل.',
      '4) قبل أي نشر أو جدولة يظهر تأكيد أخير مع رصيدك المتبقي.',
      '5) المجدولة: من /queue اضغط «عرض» ثم «غيّر الموعد» أو «ألغِ الجدولة» (حتى 15 دقيقة قبل الموعد).',
      '6) إن نُشرت على منصة وفشلت الأخرى: «أعد محاولة ما فشل» (تستهلك رصيداً واحداً).',
    ].join('\n'),
    COMMANDS_HELP,
    configWarnings(env).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** قائمة زر «القائمة» لمحادثة المالك؛ فشلها لا يمنع الترحيب. */
async function syncCommandMenu(ctx: Ctx): Promise<void> {
  try {
    await setChatCommands(ctx.env, ctx.chatId, BOT_COMMANDS);
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'set_commands_failed', code: err instanceof TelegramError ? err.code : 'unknown' }));
  }
}

async function handleCommand(ctx: Ctx, text: string): Promise<void> {
  const command = (text.split(/\s+/)[0] ?? '').split('@')[0]?.toLowerCase();
  switch (command) {
    case '/start':
      await syncCommandMenu(ctx);
      await sendMessage(ctx.env, ctx.chatId, welcome(ctx.env), menuKeyboard(await remindersPaused(ctx.env.DB)));
      return;
    case '/help':
      await sendMessage(ctx.env, ctx.chatId, help(ctx.env), menuKeyboard(await remindersPaused(ctx.env.DB)));
      return;
    case '/ideas':
      await listIdeas(ctx);
      return;
    case '/plan':
      await runPlan(ctx);
      return;
    case '/queue':
      await showQueue(ctx);
      return;
    case '/stats':
      await runStats(ctx);
      return;
    case '/usage':
      await showUsage(ctx);
      return;
    case '/pause':
      await setRemindersPaused(ctx, true);
      return;
    case '/resume':
      await setRemindersPaused(ctx, false);
      return;
    case '/export':
      await exportBackup(ctx);
      return;
    default:
      await sendMessage(ctx.env, ctx.chatId, 'أمر غير معروف. أرسل /help لعرض الأوامر.');
  }
}

export async function handleMessage(ctx: Ctx, msg: TgMessage): Promise<void> {
  const db = ctx.env.DB;
  const text = msg.text?.trim();

  // الأوامر، وأزرار اللوحة الثابتة (تصل نصاً فتُعامل أمراً ولا تُحفظ فكرةً)
  const command = text?.startsWith('/') ? text : text ? menuCommand(text) : null;
  if (command) {
    await clearAwaiting(db);
    await handleCommand(ctx, command);
    return;
  }

  if (text) {
    // حالة awaiting_edit: النص التالي ملاحظات على المسودة؛ وأي نص يلغي انتظار الصورة
    const edit = await getAwaiting(db, 'edit');
    await clearAwaiting(db);
    if (edit) await reviseDraft(ctx, edit.draft_id, text);
    else await saveIdea(ctx, text, 'text');
    return;
  }

  const image = pickImage(msg);
  if (image) {
    const awaiting = await getAwaiting(db, 'image');
    await clearAwaiting(db);
    if (awaiting) {
      await attachImage(ctx, awaiting.draft_id, image);
      return;
    }
    // صورة بلا حالة awaiting_image: فكرة جديدة مصدرها photo ونصها التعليق (SPEC §8 الصور 5)
    const caption = msg.caption?.trim();
    if (caption) {
      await saveIdea(ctx, caption, 'photo');
      return;
    }
    await sendMessage(
      ctx.env,
      ctx.chatId,
      'لم أحفظ الصورة: أرسلها مع تعليق يشرح الفكرة لأحفظها فكرةً جديدة، أو اضغط «🖼 أرفق صورة» على المسودة ثم أرسلها.',
    );
    return;
  }

  const audio = msg.voice ?? msg.audio;
  if (audio) {
    await clearAwaiting(db);
    await handleVoice(ctx, audio);
    return;
  }

  await sendMessage(ctx.env, ctx.chatId, 'أرسل فكرتك نصاً، أو صورة مع تعليق.');
}
