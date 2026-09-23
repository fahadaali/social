// اقتراح الموضوعات (SPEC §10 plan): /plan، وزر «اقترح موضوعاً» في التذكير، والخطة الأسبوعية (SPEC §9).
// تستفيد من آخر لقطة مقاييس لأداء المحاور (SPEC §12 المرحلة 3)، ومن أحداث بحث الويب في خطة الأحد
// ونشرة الأربعاء (NOTES.md القسم 11).

import { loadSnapshot, performanceSection } from './analytics.ts';
import { claudeErrorMessage, claudeJson } from './claude.ts';
import { PILLARS, PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import { getJsonState, insertIdea, listNewIdeas, recentPublished, setIdeaPillar, setState, STATE_KEYS } from './db.ts';
import { formulateIdea } from './drafting.ts';
import { draftModel } from './env.ts';
import { rememberEvents } from './events.ts';
import { CB, retryKeyboard } from './preview.ts';
import type { EventDigest, EventSource } from './prompts/events.ts';
import { PLAN_MAX_TOKENS, parsePlan, planSchema, planSystem, planUser, type PlanSuggestion } from './prompts/plan.ts';
import { button, editMessageText, sendMessage, type InlineKeyboard } from './telegram.ts';
import { daysBetween, formatRiyadhDate, parseUtc } from './time.ts';

interface StoredPlan {
  nonce: string;
  suggestions: PlanSuggestion[];
}

export interface PlanMessage {
  text: string;
  keyboard: InlineKeyboard;
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PlanRun {
  title: string;
  events: EventDigest | null;
  /** نشرة الأحداث: كل الاقتراحات من الأحداث، وقد لا يوجد منها شيء. */
  eventsOnly: boolean;
  /** مفتاح حفظ الاقتراحات: منفصل لنشرة الأربعاء حتى تبقى أزرار خطة الأحد صالحة. */
  stateKey: string;
}

/** يولّد الاقتراحات ويحفظها، ويعيد الرسالة وأزرار «صُغها»، أو null لنشرة بلا اقتراحات. يرمي عند الفشل. */
async function buildPlan(ctx: Ctx, run: PlanRun): Promise<PlanMessage | null> {
  const { env } = ctx;
  const now = new Date();
  const ideas = await listNewIdeas(env.DB, 40, true);
  const recent = await recentPublished(env.DB, 10);
  const performance = performanceSection(await loadSnapshot(env.DB));
  const events = run.events ? { digest: run.events, only: run.eventsOnly } : null;
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
          performance,
          events,
        ),
      },
    ],
    schema: planSchema(PILLARS, events !== null),
    maxTokens: PLAN_MAX_TOKENS,
    deadline: ctx.deadline,
    parse: parsePlan(new Set(ideas.map((i) => i.id)), { sources: run.events?.sources, eventsOnly: run.eventsOnly }),
    label: run.eventsOnly ? 'events_plan' : 'plan',
  });
  if (suggestions.length === 0) return null;

  const nonce = newNonce();
  await setState(env.DB, run.stateKey, JSON.stringify({ nonce, suggestions } satisfies StoredPlan));
  await rememberEvents(env.DB, suggestions.flatMap((s) => (s.source ? [s.source] : [])));

  const blocks = suggestions.map((s, i) => {
    const head = s.idea_id !== null ? `الفكرة #${s.idea_id}` : 'موضوع جديد';
    const pillar = s.pillar ? ` [${s.pillar}]` : '';
    const why = s.why_now ? `\nلماذا الآن: ${s.why_now}` : '';
    const source = s.source ? `\nالمصدر: ${s.source.title} — ${s.source.url}` : '';
    return `${i + 1}) ${head}${pillar}\nالزاوية: ${s.angle}${why}${source}`;
  });
  return {
    text: `${run.title}\n\n${blocks.join('\n\n')}`,
    keyboard: { inline_keyboard: suggestions.map((_, i) => [button(`صُغها (${i + 1})`, CB.planPick(nonce, i))]) },
  };
}

/** /plan والخطة الأسبوعية؛ مع events يُبنى اقتراح أو اثنان على الأحداث. يرمي عند الفشل. */
export async function generatePlan(ctx: Ctx, title = '💡 اقتراحات للنشر:', events: EventDigest | null = null): Promise<PlanMessage> {
  const plan = await buildPlan(ctx, { title, events, eventsOnly: false, stateKey: STATE_KEYS.lastPlan });
  // parsePlan يرمي قبل ذلك عند غياب الاقتراحات خارج نشرة الأحداث
  if (!plan) throw new Error('no suggestions');
  return plan;
}

/** نشرة الأربعاء: اقتراحات من الأحداث وحدها، وnull إن لم يكن فيها ما يستحق. */
export function generateEventsPlan(ctx: Ctx, events: EventDigest): Promise<PlanMessage | null> {
  return buildPlan(ctx, {
    title: '📰 أحداث منتصف الأسبوع — اقتراحات للنشر:',
    events,
    eventsOnly: true,
    stateKey: STATE_KEYS.lastEventsPlan,
  });
}

/** /plan وزر «اقترح موضوعاً»: رسالة انتظار ثم الاقتراحات، أو الخطأ مع «أعد المحاولة». */
export async function runPlan(ctx: Ctx): Promise<void> {
  const { env } = ctx;
  const placeholder = await sendMessage(env, ctx.chatId, '⏳ أجهّز اقتراحات للنشر…');
  try {
    const plan = await generatePlan(ctx);
    await editMessageText(env, ctx.chatId, placeholder.message_id, plan.text, plan.keyboard);
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

/** سياق الحدث مع الزاوية، حتى تستند الصياغة إلى الحدث ومصدره لا إلى الذاكرة. */
function withEvent(s: PlanSuggestion, source: EventSource): string {
  return [s.angle, s.why_now ? `الحدث: ${s.why_now}` : '', `المصدر: ${source.title} — ${source.url}`].filter(Boolean).join('\n');
}

/**
 * «صُغها» على اقتراح: فكرة موجودة تُصاغ بزاوية الاقتراح، وموضوع جديد يُحفظ فكرةً ثم يُصاغ.
 * يُبحث عن الاقتراح في خطة الأحد (أو /plan) وفي نشرة الأربعاء بحسب رمزها.
 */
export async function pickSuggestion(ctx: Ctx, nonce: string, index: number): Promise<void> {
  const db = ctx.env.DB;
  let s: PlanSuggestion | undefined;
  for (const key of [STATE_KEYS.lastPlan, STATE_KEYS.lastEventsPlan]) {
    const plan = await getJsonState<StoredPlan>(db, key);
    if (plan && plan.nonce === nonce) {
      s = plan.suggestions[index];
      break;
    }
  }
  if (!s) {
    await sendMessage(ctx.env, ctx.chatId, 'هذه الاقتراحات قديمة. اطلب اقتراحات جديدة بالأمر /plan.');
    return;
  }
  // الخطط المحفوظة قبل إضافة الأحداث لا تحمل source
  const source = s.source ?? null;
  const angle = source ? withEvent(s, source) : s.angle;
  if (s.idea_id !== null) {
    await formulateIdea(ctx, s.idea_id, angle);
    return;
  }
  const idea = await insertIdea(db, angle, source ? 'event' : 'plan');
  if (s.pillar) await setIdeaPillar(db, idea.id, s.pillar);
  await formulateIdea(ctx, idea.id);
}
