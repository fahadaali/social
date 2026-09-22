// plan — SPEC §10: المدخل الأفكار الجديدة والمحاور وعناوين آخر 10 منشورات،
// والمخرج { "suggestions": [ { "idea_id": 12, "angle": "string", "why_now": "string" } ] }
// أضفنا حقل pillar لكل اقتراح: يلزم لتصنيف الموضوع الجديد (idea_id: null) عند حفظه فكرةً،
// ويُعرض مع الاقتراح — انظر NOTES.md.

import { truncate } from '../text.ts';
import { assistantSystemPrompt, quote } from './shared.ts';

export const PLAN_MAX_TOKENS = 1500;
export const PLAN_SIZE = 3;

const OTHER = 'أخرى';

export function planSchema(pillars: string[]): Record<string, unknown> {
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
          },
          required: ['idea_id', 'pillar', 'angle', 'why_now'],
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
}

export function planSystem(pillarsMd: string): string {
  return assistantSystemPrompt(pillarsMd, 'مهمتك تخطيط النشر الأسبوعي للمالك من بنك أفكاره ومحاور محتواه.');
}

export function planUser(today: string, ideas: PlanIdea[], recentTitles: string[], performance?: string | null): string {
  const ideaLines = ideas.length
    ? ideas
        .map((i) => `- #${i.id} [${i.pillar ?? 'غير مصنّف'}] (منذ ${i.age_days} يوماً): ${truncate(i.text, 280)}`)
        .join('\n')
    : 'لا توجد أفكار جديدة في البنك.';
  const recent = recentTitles.length ? recentTitles.map((t) => `- ${truncate(t, 160)}`).join('\n') : 'لا يوجد بعد.';
  return [
    `اليوم: ${today}.`,
    `المهمة: اقترح ${PLAN_SIZE} موضوعات للنشر.`,
    `بنك الأفكار (الحالة new، الأقدم أولاً):\n${quote('ideas', ideaLines)}`,
    `عناوين آخر المنشورات (تجنّب تكرارها):\n${quote('recent', recent)}`,
    performance ? quote('performance', performance) : '',
    [
      'الضوابط:',
      `- ${PLAN_SIZE} اقتراحات موزعة على محاور مختلفة قدر الإمكان، مع تفضيل الأفكار الأقدم.`,
      '- idea_id رقم فكرة من القائمة أعلاه فقط.',
      '- pillar: محور الاقتراح من قائمة المحاور.',
      `- إذا قلّت الأفكار عن ${PLAN_SIZE}، يُسمح باقتراح موضوع جديد من المحاور مع idea_id: null.`,
      '- angle: الزاوية المقترحة للمنشور في جملة أو جملتين.',
      '- why_now: سبب مختصر لملاءمة الموضوع الآن، استناداً إلى التوازن بين المحاور وعمر الفكرة وما نُشر مؤخراً وأداء المحاور إن وُجد، دون اختلاق أحداث أو مناسبات أو أرقام.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parsePlan(validIds: Set<number>) {
  return (raw: unknown): PlanSuggestion[] => {
    const list = (raw as { suggestions?: unknown } | null)?.suggestions;
    if (!Array.isArray(list)) throw new Error('suggestions missing');
    const out: PlanSuggestion[] = [];
    const used = new Set<number>();
    for (const item of list) {
      const s = (item ?? {}) as Record<string, unknown>;
      if (typeof s.angle !== 'string' || !s.angle.trim()) continue;
      // رقم غير موجود في القائمة يُعامل موضوعاً جديداً؛ والفكرة المكررة تُتجاوز
      const id = typeof s.idea_id === 'number' && validIds.has(s.idea_id) ? s.idea_id : null;
      if (id !== null && used.has(id)) continue;
      if (id !== null) used.add(id);
      out.push({
        idea_id: id,
        pillar: typeof s.pillar === 'string' && s.pillar.trim() ? s.pillar.trim() : null,
        angle: s.angle.trim(),
        why_now: typeof s.why_now === 'string' ? s.why_now.trim() : '',
      });
      if (out.length === PLAN_SIZE) break;
    }
    if (out.length === 0) throw new Error('no usable suggestions');
    return out;
  };
}
