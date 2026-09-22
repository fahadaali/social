// الرسائل النصية والأوامر والصور (SPEC §7).

import { PILLARS, VOICE_FILLED } from '../content.ts';
import type { Ctx } from '../context.ts';
import { clearAwaiting, getAwaiting } from '../db.ts';
import { reviseDraft } from '../drafting.ts';
import { accountId, isDryRun, type Env } from '../env.ts';
import { listIdeas, saveIdea } from '../ideas.ts';
import { attachImage, pickImage } from '../images.ts';
import { runPlan } from '../planning.ts';
import { sendMessage, type TgMessage } from '../telegram.ts';

const COMMANDS_HELP = `الأوامر:
/ideas — آخر 10 أفكار جديدة، لكل فكرة زر «صُغها»
/plan — اقتراح 3 موضوعات للنشر
/help — المساعدة`;

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
      '• أرسل أي فكرة نصاً (أو صورة مع تعليق) وسأحفظها في بنك الأفكار وأصنّف محورها.',
      '• اضغط «صُغها الآن» لأجهّز ثريد X ونص لينكدن وسكربت سناب.',
      '• لا يُنشر ولا يُجدول أي شيء إلا بعد ضغطك «تأكيد».',
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
      '1) أرسل فكرتك نصاً ← أحفظها وأصنّف محورها.',
      '2) «صُغها الآن» ← مسودة فيها ثريد X ونص لينكدن وسكربت سناب.',
      '3) أزرار المسودة: ✅ انشر الآن، 🕒 جدول، ✏️ عدّل (اكتب ملاحظاتك)، 🔁 صياغة جديدة، 🖼 أرفق صورة، X/LinkedIn لتفعيل المنصات، 🗑 تجاهل.',
      '4) قبل أي نشر أو جدولة يظهر تأكيد أخير مع رصيدك المتبقي.',
    ].join('\n'),
    COMMANDS_HELP,
    configWarnings(env).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function handleCommand(ctx: Ctx, text: string): Promise<void> {
  const command = (text.split(/\s+/)[0] ?? '').split('@')[0]?.toLowerCase();
  switch (command) {
    case '/start':
      await sendMessage(ctx.env, ctx.chatId, welcome(ctx.env));
      return;
    case '/help':
      await sendMessage(ctx.env, ctx.chatId, help(ctx.env));
      return;
    case '/ideas':
      await listIdeas(ctx);
      return;
    case '/plan':
      await runPlan(ctx);
      return;
    case '/queue':
    case '/stats':
    case '/usage':
    case '/pause':
    case '/resume':
      await sendMessage(ctx.env, ctx.chatId, 'هذا الأمر ضمن المرحلة التالية من المشروع ولم يُفعَّل بعد.');
      return;
    default:
      await sendMessage(ctx.env, ctx.chatId, 'أمر غير معروف. أرسل /help لعرض الأوامر.');
  }
}

export async function handleMessage(ctx: Ctx, msg: TgMessage): Promise<void> {
  const db = ctx.env.DB;
  const text = msg.text?.trim();

  if (text?.startsWith('/')) {
    await clearAwaiting(db);
    await handleCommand(ctx, text);
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

  if (msg.voice || msg.audio) {
    await sendMessage(
      ctx.env,
      ctx.chatId,
      'الرسائل الصوتية ستُدعم في المرحلة التالية بعد اعتماد خدمة التفريغ. أرسل الفكرة نصاً الآن.',
    );
    return;
  }

  await sendMessage(ctx.env, ctx.chatId, 'أرسل فكرتك نصاً، أو صورة مع تعليق.');
}
