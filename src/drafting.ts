// الصياغة: مسودة جديدة، وصياغة من الصفر، والتعديل وفق الملاحظات (SPEC §7 و§10).

import { claudeErrorMessage, claudeJson, type ClaudeMessage } from './claude.ts';
import { PILLARS_MD, VOICE_MD } from './content.ts';
import { remaining, type Ctx } from './context.ts';
import {
  deleteState,
  getDraft,
  getIdea,
  insertDraft,
  recentPublished,
  replaceDraftContent,
  setIdeaStatus,
  setState,
  updateDraft,
  type Draft,
  type Idea,
} from './db.ts';
import { accountId, draftModel, PLATFORMS, type Env, type Platform } from './env.ts';
import { CB, draftKeyboard, isEditable, renderPreview, retryKeyboard } from './preview.ts';
import { DRAFT_MAX_TOKENS, DRAFT_SCHEMA, draftUser, fixViolationsTurn, regenerateUser, type IdeaInput, type RecentPost } from './prompts/draft.ts';
import { reviseUser } from './prompts/revise.ts';
import { writerSystemPrompt } from './prompts/shared.ts';
import { clearKeyboard, editMessageText, sendMessage } from './telegram.ts';
import { checkDraftLimits, parseDraftContent, type DraftContent } from './text.ts';

export const reviseNotesKey = (draftId: number) => `revise_notes:${draftId}`;

/** المنصات المفعّلة افتراضياً: ما ضُبط له معرّف حساب، أو كلتاهما إن لم يُضبط شيء بعد. */
export function defaultPlatforms(env: Env): Platform[] {
  const configured = PLATFORMS.filter((p) => accountId(env, p) !== null);
  return configured.length ? configured : [...PLATFORMS];
}

function callWriter(ctx: Ctx, messages: ClaudeMessage[], label: string): Promise<DraftContent> {
  return claudeJson(ctx.env, {
    model: draftModel(ctx.env),
    system: writerSystemPrompt(VOICE_MD, PILLARS_MD),
    cacheSystem: true,
    messages,
    schema: DRAFT_SCHEMA,
    maxTokens: DRAFT_MAX_TOKENS,
    deadline: ctx.deadline,
    parse: parseDraftContent,
    label,
  });
}

const hardCount = (c: DraftContent) => checkDraftLimits(c).filter((v) => v.hard).length;

/**
 * توليد ثم تحقق برمجي من الأطوال (SPEC §10). عند مخالفة تمنع النشر (تغريدة أطول من حد X مثلاً)
 * يُعاد الطلب مرة واحدة مع ذكر الخطأ — إن كان الوقت المتبقي يكفي، وإلا تُعرض المسودة مع التنبيه.
 */
async function generateChecked(ctx: Ctx, messages: ClaudeMessage[], label: string): Promise<DraftContent> {
  const started = Date.now();
  const first = await callWriter(ctx, messages, label);
  const violations = checkDraftLimits(first);
  if (!violations.some((v) => v.hard)) return first;

  const firstDuration = Date.now() - started;
  if (remaining(ctx) < firstDuration * 1.2 + 4_000) {
    console.warn(JSON.stringify({ evt: 'fix_skipped_no_time', label, left: remaining(ctx) }));
    return first;
  }
  try {
    const second = await callWriter(ctx, [...messages, ...fixViolationsTurn(first, violations)], `${label}_fix`);
    return hardCount(second) <= hardCount(first) ? second : first;
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'fix_failed', label, err: err instanceof Error ? err.message : 'unknown' }));
    return first;
  }
}

async function recentForPrompt(env: Env): Promise<RecentPost[]> {
  const drafts = await recentPublished(env.DB, 5);
  return drafts.map((d) => ({ first_tweet: d.x_segments[0] ?? d.linkedin_text }));
}

function ideaInput(idea: Idea | null, draft?: Draft): IdeaInput {
  if (idea) return { id: idea.id, text: idea.text, pillar: idea.pillar };
  // احتياط لمسودة بلا فكرة: نصها يمثّل الفكرة
  return { id: 0, text: draft ? `${draft.x_segments.join('\n')}\n\n${draft.linkedin_text}` : '', pillar: null };
}

/**
 * يعرض المعاينة: يعدّل رسالة «جاري الصياغة…» بالنتيجة، ويقسّمها عند تجاوز حد تيليجرام
 * مع إبقاء الأزرار في الرسالة الأخيرة، ثم يزيل أزرار المعاينة السابقة.
 */
export async function showPreview(ctx: Ctx, draft: Draft, idea: Idea | null, placeholderId?: number): Promise<void> {
  const chunks = renderPreview(draft, idea);
  const keyboard = draftKeyboard(draft);
  let lastId = placeholderId ?? 0;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const text = chunks[i] ?? '';
    if (i === 0 && placeholderId) {
      await editMessageText(ctx.env, ctx.chatId, placeholderId, text, isLast ? keyboard : undefined);
    } else {
      const msg = await sendMessage(ctx.env, ctx.chatId, text, isLast ? keyboard : undefined);
      lastId = msg.message_id;
    }
  }
  if (draft.telegram_message_id && draft.telegram_message_id !== lastId) {
    await clearKeyboard(ctx.env, ctx.chatId, draft.telegram_message_id);
  }
  await updateDraft(ctx.env.DB, draft.id, { telegram_message_id: lastId });
}

async function failPlaceholder(ctx: Ctx, placeholderId: number, err: unknown, retryData: string): Promise<void> {
  console.error(JSON.stringify({ evt: 'drafting_failed', err: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
  await editMessageText(
    ctx.env,
    ctx.chatId,
    placeholderId,
    `❌ تعذّرت الصياغة: ${claudeErrorMessage(err)}`,
    retryKeyboard(retryData),
  );
}

/** «صُغها الآن» / «صُغها»: مسودة جديدة من فكرة، مع زاوية اختيارية من الخطة. */
export async function formulateIdea(ctx: Ctx, ideaId: number, angle?: string): Promise<void> {
  const idea = await getIdea(ctx.env.DB, ideaId);
  if (!idea) {
    await sendMessage(ctx.env, ctx.chatId, `لم أجد الفكرة #${ideaId}.`);
    return;
  }
  const placeholder = await sendMessage(ctx.env, ctx.chatId, `⏳ جاري الصياغة… (الفكرة #${idea.id})`);
  try {
    const recent = await recentForPrompt(ctx.env);
    const content = await generateChecked(ctx, [{ role: 'user', content: draftUser(ideaInput(idea), recent, angle) }], 'draft');
    const draft = await insertDraft(ctx.env.DB, idea.id, content, defaultPlatforms(ctx.env));
    if (idea.status === 'new') await setIdeaStatus(ctx.env.DB, idea.id, 'drafted');
    await showPreview(ctx, draft, { ...idea, status: idea.status === 'new' ? 'drafted' : idea.status }, placeholder.message_id);
  } catch (err) {
    await failPlaceholder(ctx, placeholder.message_id, err, CB.retry('f', idea.id));
  }
}

async function loadEditable(ctx: Ctx, draftId: number): Promise<{ draft: Draft; idea: Idea | null } | null> {
  const draft = await getDraft(ctx.env.DB, draftId);
  if (!draft) {
    await sendMessage(ctx.env, ctx.chatId, `لم أجد المسودة #${draftId}.`);
    return null;
  }
  if (!isEditable(draft)) {
    await sendMessage(ctx.env, ctx.chatId, `لا يمكن تعديل المسودة #${draftId} في حالتها الحالية.`);
    return null;
  }
  const idea = draft.idea_id ? await getIdea(ctx.env.DB, draft.idea_id) : null;
  return { draft, idea };
}

/** 🔁 صياغة جديدة من الصفر بزاوية مختلفة. ترفع رقم النسخة. */
export async function regenerateDraft(ctx: Ctx, draftId: number): Promise<void> {
  const loaded = await loadEditable(ctx, draftId);
  if (!loaded) return;
  const { draft, idea } = loaded;
  const placeholder = await sendMessage(ctx.env, ctx.chatId, `⏳ جاري صياغة جديدة للمسودة #${draft.id}…`);
  try {
    const recent = await recentForPrompt(ctx.env);
    const content = await generateChecked(
      ctx,
      [{ role: 'user', content: regenerateUser(ideaInput(idea, draft), draft, recent) }],
      'regenerate',
    );
    const updated = await replaceDraftContent(ctx.env.DB, draft.id, content);
    if (!updated) {
      await editMessageText(ctx.env, ctx.chatId, placeholder.message_id, `تغيّرت حالة المسودة #${draft.id} فلم تُحدَّث.`);
      return;
    }
    await showPreview(ctx, updated, idea, placeholder.message_id);
  } catch (err) {
    await failPlaceholder(ctx, placeholder.message_id, err, CB.retry('g', draft.id));
  }
}

/** ✏️ عدّل: إعادة الصياغة وفق ملاحظات المالك بنصها. ترفع رقم النسخة (معيار القبول 5). */
export async function reviseDraft(ctx: Ctx, draftId: number, notes: string): Promise<void> {
  const loaded = await loadEditable(ctx, draftId);
  if (!loaded) return;
  const { draft, idea } = loaded;
  // نحفظ الملاحظات ليعمل زر «أعد المحاولة» دون إعادة كتابتها
  await setState(ctx.env.DB, reviseNotesKey(draft.id), notes);
  const placeholder = await sendMessage(ctx.env, ctx.chatId, `⏳ جاري تعديل المسودة #${draft.id} وفق ملاحظاتك…`);
  try {
    const content = await generateChecked(ctx, [{ role: 'user', content: reviseUser(idea, draft, notes) }], 'revise');
    const updated = await replaceDraftContent(ctx.env.DB, draft.id, content);
    if (!updated) {
      await editMessageText(ctx.env, ctx.chatId, placeholder.message_id, `تغيّرت حالة المسودة #${draft.id} فلم تُعدَّل.`);
      return;
    }
    await deleteState(ctx.env.DB, reviseNotesKey(draft.id));
    await showPreview(ctx, updated, idea, placeholder.message_id);
  } catch (err) {
    await failPlaceholder(ctx, placeholder.message_id, err, CB.retry('e', draft.id));
  }
}
