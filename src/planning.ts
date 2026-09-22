// اقتراح الموضوعات (SPEC §10 plan). يحتاجه زر «اقترح موضوعاً» في تذكير المهمة اليومية (SPEC §9).

import { claudeErrorMessage, claudeJson } from './claude.ts';
import { PILLARS, PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import { getJsonState, insertIdea, listNewIdeas, recentPublished, setIdeaPillar, setState } from './db.ts';
import { formulateIdea } from './drafting.ts';
import { draftModel } from './env.ts';
import { CB, retryKeyboard } from './preview.ts';
import { PLAN_MAX_TOKENS, parsePlan, planSchema, planSystem, planUser, type PlanSuggestion } from './prompts/plan.ts';
import { button, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';
import { daysBetween, formatRiyadhDate, parseUtc } from './time.ts';

const LAST_PLAN_KEY = 'last_plan';

interface StoredPlan {
  nonce: string;
  suggestions: PlanSuggestion[];
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runPlan(ctx: Ctx): Promise<void> {
  const { env } = ctx;
  const placeholder = await sendMessage(env, ctx.chatId, '⏳ أجهّز اقتراحات للنشر…');
  try {
    const now = new Date();
    const ideas = await listNewIdeas(env.DB, 40, true);
    const recent = await recentPublished(env.DB, 10);
    const suggestions = await claudeJson(env, {
      model: draftModel(env),
      system: planSystem(PILLARS_MD),
      messages: [
        {
          role: 'user',
          content: planUser(
            formatRiyadhDate(now),
            ideas.map((i) => ({
              id: i.id,
              pillar: i.pillar,
              text: i.text,
              age_days: Math.max(0, daysBetween(parseUtc(i.created_at), now)),
            })),
            recent.map((d) => d.x_segments[0] ?? d.linkedin_text),
          ),
        },
      ],
      schema: planSchema(PILLARS),
      maxTokens: PLAN_MAX_TOKENS,
      deadline: ctx.deadline,
      parse: parsePlan(new Set(ideas.map((i) => i.id))),
      label: 'plan',
    });

    const nonce = newNonce();
    await setState(env.DB, LAST_PLAN_KEY, JSON.stringify({ nonce, suggestions } satisfies StoredPlan));

    const blocks = suggestions.map((s, i) => {
      const head = s.idea_id !== null ? `الفكرة #${s.idea_id}` : 'موضوع جديد';
      const pillar = s.pillar ? ` [${s.pillar}]` : '';
      return `${i + 1}) ${head}${pillar}\nالزاوية: ${s.angle}${s.why_now ? `\nلماذا الآن: ${s.why_now}` : ''}`;
    });
    const keyboard: InlineKeyboard = {
      inline_keyboard: suggestions.map((_, i) => [button(`صُغها (${i + 1})`, CB.planPick(nonce, i))]),
    };
    await editMessageText(env, ctx.chatId, placeholder.message_id, `💡 اقتراحات للنشر:\n\n${blocks.join('\n\n')}`, keyboard);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'plan_failed', err: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
    await editMessageText(
      env,
      ctx.chatId,
      placeholder.message_id,
      `❌ تعذّر تجهيز الاقتراحات: ${claudeErrorMessage(err)}`,
      retryKeyboard(CB.retry('p', 0)),
    );
  }
}

/** «صُغها» على اقتراح: فكرة موجودة تُصاغ بزاوية الاقتراح، وموضوع جديد يُحفظ فكرةً ثم يُصاغ. */
export async function pickSuggestion(ctx: Ctx, nonce: string, index: number): Promise<void> {
  const plan = await getJsonState<StoredPlan>(ctx.env.DB, LAST_PLAN_KEY);
  const s = plan && plan.nonce === nonce ? plan.suggestions[index] : undefined;
  if (!s) {
    await sendMessage(ctx.env, ctx.chatId, 'هذه الاقتراحات قديمة. اطلب اقتراحات جديدة بالأمر /plan.');
    return;
  }
  if (s.idea_id !== null) {
    await formulateIdea(ctx, s.idea_id, s.angle);
    return;
  }
  const idea = await insertIdea(ctx.env.DB, s.angle, 'plan');
  if (s.pillar) await setIdeaPillar(ctx.env.DB, idea.id, s.pillar);
  await formulateIdea(ctx, idea.id);
}
