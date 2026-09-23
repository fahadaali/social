// plan — SPEC §10: المدخل الأفكار الجديدة والمحاور وعناوين آخر 10 منشورات،
// والمخرج { "suggestions": [ { "idea_id": 12, "angle": "string", "why_now": "string" } ] }
// أضفنا حقل pillar لكل اقتراح: يلزم لتصنيف الموضوع الجديد (idea_id: null) عند حفظه فكرةً،
// ويُعرض مع الاقتراح — انظر NOTES.md.
// ومع أحداث بحث الويب (NOTES.md القسم 11) يُضاف حقل source: رقم المصدر الذي بُني عليه الاقتراح.

import { truncate } from '../text.ts';
import type { EventDigest, EventSource } from './events.ts';
import { assistantSystemPrompt, quote } from './shared.ts';

export const PLAN_MAX_TOKENS = 1500;
export const PLAN_SIZE = 3;

const OTHER = 'أخرى';

export function planSchema(pillars: string[], withEvents = false): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            idea_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            pillar: pillars.length ? { type: 'string', enum: [...pillars, OTHER] } : { type: 'string' },
            angle: { type: 'string' },
            why_now: { type: 'string' },
            ...(withEvents ? { source: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } : {}),
          },
          required: ['idea_id', 'pillar', 'angle', 'why_now', ...(withEvents ? ['source'] : [])],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  };
}

export interface PlanIdea {
  id: number;
  pillar: string | null;
  text: string;
  age_days: number;
}

export interface PlanSuggestion {
  idea_id: number | null;
  pillar: string | null;
  angle: string;
  why_now: string;
  /** الحدث الذي بُني عليه الاقتراح (من نتائج البحث)، وnull لغيره. */
  source: EventSource | null;
}

/** أحداث بحث الويب في الخطة: only = نشرة الأحداث (كل الاقتراحات منها، وقد لا يوجد شيء). */
export interface PlanEvents {
  digest: EventDigest;
  only: boolean;
}

export function planSystem(pillarsMd: string): string {
  return assistantSystemPrompt(pillarsMd, 'مهمتك تخطيط النشر الأسبوعي للمالك من بنك أفكاره ومحاور محتواه.');
}

function eventsSection(digest: EventDigest): string {
  const sources = digest.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n');
  return [
    `أحداث الأيام الأخيرة من بحث الويب (الأرقام بين قوسين تشير إلى المصادر):\n${quote('events', digest.text)}`,
    `المصادر:\n${quote('sources', sources)}`,
  ].join('\n\n');
}

export function planUser(
  today: string,
  ideas: PlanIdea[],
  recentTitles: string[],
  performance?: string | null,
  events?: PlanEvents | null,
): string {
  const ideaLines = ideas.length
    ? ideas
        .map((i) => `- #${i.id} [${i.pillar ?? 'غير مصنّف'}] (منذ ${i.age_days} يوماً): ${truncate(i.text, 280)}`)
        .join('\n')
    : 'لا توجد أفكار جديدة في البنك.';
  const recent = recentTitles.length ? recentTitles.map((t) => `- ${truncate(t, 160)}`).join('\n') : 'لا يوجد بعد.';
  const task = events?.only
    ? `المهمة: اقترح حتى ${PLAN_SIZE} موضوعات للنشر مبنية على أحداث الأيام الأخيرة.`
    : `المهمة: اقترح ${PLAN_SIZE} موضوعات للنشر.`;
  // بلا أحداث تبقى الضوابط كما كانت نصاً وترتيباً
  const rules = ['الضوابط:'];
  if (events?.only) {
    rules.push(
      `- كل اقتراح مبني على حدث من القائمة، من 1 إلى ${PLAN_SIZE} اقتراحات، الأهم لجمهور المالك أولاً. إن لم يكن فيها ما يستحق فأعد قائمة فارغة.`,
      '- يجوز ربط الحدث بفكرة من البنك عبر idea_id إن كانت عن الموضوع نفسه، وإلا idea_id: null.',
    );
  } else {
    rules.push(
      `- ${PLAN_SIZE} اقتراحات موزعة على محاور مختلفة قدر الإمكان، مع تفضيل الأفكار الأقدم.`,
      '- idea_id رقم فكرة من القائمة أعلاه فقط.',
    );
  }
  rules.push('- pillar: محور الاقتراح من قائمة المحاور.');
  if (!events?.only) {
    rules.push(`- إذا قلّت الأفكار عن ${PLAN_SIZE}، يُسمح باقتراح موضوع جديد من المحاور مع idea_id: null.`);
  }
  if (events && !events.only) {
    rules.push('- واحد أو اثنان من الاقتراحات على الأكثر مبنيان على أحداث من القائمة، إن وُجد فيها ما يناسب المحاور.');
  }
  rules.push('- angle: الزاوية المقترحة للمنشور في جملة أو جملتين.');
  if (events) {
    rules.push(
      '- source: رقم المصدر الذي بُني عليه الاقتراح من قائمة المصادر، وnull لغير ذلك. لا تخترع رقماً.',
      '- why_now: سبب مختصر لملاءمة الموضوع الآن. للاقتراح المبني على حدث: الحدث وتاريخه كما في القائمة، دون أي تفصيل غير موجود فيها. ولا تذكر أحداثاً أو مناسبات أو أرقاماً من خارج القائمة.',
    );
  } else {
    rules.push(
      '- why_now: سبب مختصر لملاءمة الموضوع الآن، استناداً إلى التوازن بين المحاور وعمر الفكرة وما نُشر مؤخراً وأداء المحاور إن وُجد، دون اختلاق أحداث أو مناسبات أو أرقام.',
    );
  }
  return [
    `اليوم: ${today}.`,
    task,
    `بنك الأفكار (الحالة new، الأقدم أولاً):\n${quote('ideas', ideaLines)}`,
    `عناوين آخر المنشورات (تجنّب تكرارها):\n${quote('recent', recent)}`,
    performance ? quote('performance', performance) : '',
    events ? eventsSection(events.digest) : '',
    rules.join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface ParsePlanOptions {
  /** مصادر الأحداث التي يشير إليها حقل source (بترقيم يبدأ من 1). */
  sources?: EventSource[];
  /** نشرة الأحداث: يُقبل المبني على مصدر صحيح فقط، وتُقبل القائمة الفارغة. */
  eventsOnly?: boolean;
}

export function parsePlan(validIds: Set<number>, opts: ParsePlanOptions = {}) {
  const sources = opts.sources ?? [];
  return (raw: unknown): PlanSuggestion[] => {
    const list = (raw as { suggestions?: unknown } | null)?.suggestions;
    if (!Array.isArray(list)) throw new Error('suggestions missing');
    const out: PlanSuggestion[] = [];
    const used = new Set<number>();
    for (const item of list) {
      const s = (item ?? {}) as Record<string, unknown>;
      if (typeof s.angle !== 'string' || !s.angle.trim()) continue;
      // رقم مصدر خارج القائمة يُهمل، فلا يظهر رابط لم يأتِ من نتائج البحث
      const n = s.source;
      const source = typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= sources.length ? sources[n - 1]! : null;
      if (opts.eventsOnly && !source) continue;
      // رقم غير موجود في القائمة يُعامل موضوعاً جديداً؛ والفكرة المكررة تُتجاوز
      const id = typeof s.idea_id === 'number' && validIds.has(s.idea_id) ? s.idea_id : null;
      if (id !== null && used.has(id)) continue;
      if (id !== null) used.add(id);
      out.push({
        idea_id: id,
        pillar: typeof s.pillar === 'string' && s.pillar.trim() ? s.pillar.trim() : null,
        angle: s.angle.trim(),
        why_now: typeof s.why_now === 'string' ? s.why_now.trim() : '',
        source,
      });
      if (out.length === PLAN_SIZE) break;
    }
    if (out.length === 0 && !opts.eventsOnly) throw new Error('no usable suggestions');
    return out;
  };
}
