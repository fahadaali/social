// بنك الأفكار: الحفظ والتصنيف الآلي والعرض (SPEC §7).

import { claudeErrorMessage, claudeJson } from './claude.ts';
import { PILLARS, PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import { getIdea, insertIdea, listNewIdeas, setIdeaPillar, type Idea, type IdeaSource } from './db.ts';
import { fastModel } from './env.ts';
import { CB } from './preview.ts';
import {
  CLASSIFY_MAX_TOKENS,
  classifySchema,
  classifySystem,
  classifyUser,
  parseClassify,
  type ClassifyResult,
} from './prompts/classify.ts';
import { button, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';
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

/** يصنّف الفكرة ويرد: «حُفظت الفكرة #12 (محور: الحوكمة)» مع زر «صُغها الآن». */
async function classifyAndReport(ctx: Ctx, idea: Idea, editMessageId?: number): Promise<void> {
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
  if (editMessageId) await editMessageText(ctx.env, ctx.chatId, editMessageId, text, keyboard);
  else await sendMessage(ctx.env, ctx.chatId, text, keyboard);
}

export async function saveIdea(ctx: Ctx, text: string, source: IdeaSource): Promise<void> {
  const idea = await insertIdea(ctx.env.DB, text.trim(), source);
  await classifyAndReport(ctx, idea);
}

export async function reclassifyIdea(ctx: Ctx, ideaId: number, messageId: number): Promise<void> {
  const idea = await getIdea(ctx.env.DB, ideaId);
  if (!idea) {
    await sendMessage(ctx.env, ctx.chatId, `لم أجد الفكرة #${ideaId}.`);
    return;
  }
  await classifyAndReport(ctx, idea, messageId);
}

/** /ideas: آخر 10 أفكار بحالة new، لكل فكرة زر «صُغها». */
export async function listIdeas(ctx: Ctx): Promise<void> {
  const ideas = await listNewIdeas(ctx.env.DB, 10);
  if (ideas.length === 0) {
    await sendMessage(ctx.env, ctx.chatId, 'لا توجد أفكار جديدة في البنك. أرسل أي فكرة نصاً لأحفظها.');
    return;
  }
  const lines = ideas.map((i) => `#${i.id} — ${i.pillar ?? 'غير مصنّف'}\n${truncate(i.text, 140)}`);
  const keyboard: InlineKeyboard = {
    inline_keyboard: ideas.map((i) => [button(`صُغها #${i.id}`, CB.formulate(i.id))]),
  };
  await sendMessage(ctx.env, ctx.chatId, `💡 أحدث الأفكار الجديدة:\n\n${lines.join('\n\n')}`, keyboard);
}
