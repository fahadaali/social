// بنك الأفكار: الحفظ والتصنيف الآلي والعرض (SPEC §7).

import { claudeErrorMessage, claudeJson } from './claude.ts';
import { PILLARS, PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import {
  getIdea,
  insertIdea,
  listNewIdeas,
  setIdeaPillar,
  transitionIdea,
  type Idea,
  type IdeaSource,
  type IdeaStatus,
} from './db.ts';
import { fastModel } from './env.ts';
import { archivedIdeaRow, CB, ideaListRow, replaceIdeaRow } from './preview.ts';
import {
  CLASSIFY_MAX_TOKENS,
  classifySchema,
  classifySystem,
  classifyUser,
  parseClassify,
  type ClassifyResult,
} from './prompts/classify.ts';
import { button, editKeyboard, editMessageText, sendMessage, type InlineKeyboard, type TgMessage } from './telegram.ts';
import { truncate } from './text.ts';

export function classifyIdea(ctx: Ctx, text: string): Promise<ClassifyResult> {
  return claudeJson(ctx.env, {
    model: fastModel(ctx.env),
    system: classifySystem(PILLARS_MD),
    messages: [{ role: 'user', content: classifyUser(text, PILLARS) }],
    schema: classifySchema(PILLARS),
    maxTokens: CLASSIFY_MAX_TOKENS,
    deadline: ctx.deadline,
    parse: parseClassify(PILLARS),
    label: 'classify',
  });
}

function savedKeyboard(ideaId: number, withRetry: boolean): InlineKeyboard {
  const row = [button('صُغها الآن', CB.formulate(ideaId))];
  if (withRetry) row.push(button('أعد المحاولة', CB.reclassify(ideaId)));
  return { inline_keyboard: [row] };
}

export interface ReportOptions {
  /** تعديل رسالة قائمة (مثل «أفرّغ الرسالة الصوتية…») بدل إرسال رسالة جديدة. */
  editMessageId?: number | undefined;
  /** سطر إضافي في الرد، مثل النص المفرّغ للتحقق منه. */
  extra?: string | undefined;
}

/** يصنّف الفكرة ويرد: «حُفظت الفكرة #12 (محور: الحوكمة)» مع زر «صُغها الآن». */
async function classifyAndReport(ctx: Ctx, idea: Idea, opts: ReportOptions = {}): Promise<void> {
  let text: string;
  let keyboard: InlineKeyboard;
  try {
    const result = await classifyIdea(ctx, idea.text);
    await setIdeaPillar(ctx.env.DB, idea.id, result.pillar);
    text = `حُفظت الفكرة #${idea.id} (محور: ${result.pillar})\n📝 ${result.summary}`;
    keyboard = savedKeyboard(idea.id, false);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'classify_failed', idea: idea.id, err: String(err instanceof Error ? err.message : err) }));
    text = `حُفظت الفكرة #${idea.id} (لم يُصنَّف محورها: ${claudeErrorMessage(err)})`;
    keyboard = savedKeyboard(idea.id, true);
  }
  if (opts.extra) text += `\n\n${opts.extra}`;
  if (opts.editMessageId) await editMessageText(ctx.env, ctx.chatId, opts.editMessageId, text, keyboard);
  else await sendMessage(ctx.env, ctx.chatId, text, keyboard);
}

export async function saveIdea(ctx: Ctx, text: string, source: IdeaSource, opts: ReportOptions = {}): Promise<void> {
  const idea = await insertIdea(ctx.env.DB, text.trim(), source);
  await classifyAndReport(ctx, idea, opts);
}

export async function reclassifyIdea(ctx: Ctx, ideaId: number, messageId: number): Promise<void> {
  const idea = await getIdea(ctx.env.DB, ideaId);
  if (!idea) {
    await sendMessage(ctx.env, ctx.chatId, `لم أجد الفكرة #${ideaId}.`);
    return;
  }
  await classifyAndReport(ctx, idea, { editMessageId: messageId });
}

/** /ideas: آخر 10 أفكار بحالة new، لكل فكرة زرّا «صُغها» و«أرشف». */
export async function listIdeas(ctx: Ctx): Promise<void> {
  const ideas = await listNewIdeas(ctx.env.DB, 10);
  if (ideas.length === 0) {
    await sendMessage(ctx.env, ctx.chatId, 'لا توجد أفكار جديدة في البنك. أرسل أي فكرة نصاً لأحفظها.');
    return;
  }
  const lines = ideas.map((i) => `#${i.id} — ${i.pillar ?? 'غير مصنّف'}\n${truncate(i.text, 140)}`);
  const keyboard: InlineKeyboard = { inline_keyboard: ideas.map((i) => ideaListRow(i.id)) };
  await sendMessage(ctx.env, ctx.chatId, `💡 أحدث الأفكار الجديدة:\n\n${lines.join('\n\n')}`, keyboard);
}

const IDEA_STATUS_AR: Record<IdeaStatus, string> = {
  new: 'في البنك',
  drafted: 'صيغت منها مسودة',
  published: 'نُشرت',
  archived: 'مؤرشفة',
};

export interface CallbackReply {
  text: string;
  alert: boolean;
}

async function moveIdea(
  ctx: Ctx,
  ideaId: number,
  from: IdeaStatus,
  to: IdeaStatus,
  message: TgMessage | undefined,
): Promise<CallbackReply | null> {
  if (await transitionIdea(ctx.env.DB, ideaId, from, to)) {
    // تتبدّل أزرار الفكرة في رسالة /ideas نفسها: «أرشف» ↔ «تراجع»
    const kb = replaceIdeaRow(message?.reply_markup, ideaId, to === 'archived' ? archivedIdeaRow(ideaId) : ideaListRow(ideaId));
    if (message && kb) await editKeyboard(ctx.env, ctx.chatId, message.message_id, kb);
    return null;
  }
  const idea = await getIdea(ctx.env.DB, ideaId);
  return { text: idea ? `حالة الفكرة #${ideaId} الآن: ${IDEA_STATUS_AR[idea.status]}.` : 'لم أجد هذه الفكرة.', alert: true };
}

/** «🗄 أرشف»: تخرج الفكرة من البنك دون حذف، ويمكن التراجع من الزر نفسه. */
export async function archiveIdea(ctx: Ctx, ideaId: number, message?: TgMessage): Promise<CallbackReply> {
  return (await moveIdea(ctx, ideaId, 'new', 'archived', message)) ?? { text: `🗄 أُرشفت الفكرة #${ideaId}`, alert: false };
}

export async function unarchiveIdea(ctx: Ctx, ideaId: number, message?: TgMessage): Promise<CallbackReply> {
  return (
    (await moveIdea(ctx, ideaId, 'archived', 'new', message)) ?? { text: `↩️ أُعيدت الفكرة #${ideaId} إلى البنك`, alert: false }
  );
}
