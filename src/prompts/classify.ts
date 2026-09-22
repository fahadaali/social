// classify (النموذج السريع) — SPEC §10: { "pillar": "string", "summary": "string ≤ 15 كلمة" }

import { countWords } from '../text.ts';
import { assistantSystemPrompt, quote } from './shared.ts';

export interface ClassifyResult {
  pillar: string;
  summary: string;
}

export const CLASSIFY_MAX_TOKENS = 300;
const OTHER = 'أخرى';

export function classifySchema(pillars: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      pillar: pillars.length ? { type: 'string', enum: [...pillars, OTHER] } : { type: 'string' },
      summary: { type: 'string' },
    },
    required: ['pillar', 'summary'],
    additionalProperties: false,
  };
}

export function classifySystem(pillarsMd: string): string {
  return assistantSystemPrompt(pillarsMd, 'مهمتك تصنيف أفكار المالك الخام على محاور المحتوى وتلخيصها.');
}

export function classifyUser(ideaText: string, pillars: string[]): string {
  const choice = pillars.length
    ? `اختر pillar من القائمة حرفياً: ${pillars.join('، ')}. إن لم تناسب الفكرةُ أيَّ محور فاختر «${OTHER}».`
    : 'لم تُحدَّد قائمة محاور، فاقترح في pillar اسم محور قصيراً (كلمة إلى ثلاث كلمات).';
  return [
    'صنّف الفكرة التالية.',
    quote('idea', ideaText),
    choice,
    'summary: ملخص للفكرة لا يتجاوز 15 كلمة.',
  ].join('\n\n');
}

export function parseClassify(pillars: string[]) {
  return (raw: unknown): ClassifyResult => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.pillar !== 'string' || typeof o.summary !== 'string') throw new Error('classify shape');
    const pillar = o.pillar.trim();
    if (!pillar || (pillars.length && ![...pillars, OTHER].includes(pillar))) throw new Error('unknown pillar');
    const words = o.summary.trim().split(/\s+/u);
    const summary = countWords(o.summary) > 15 ? words.slice(0, 15).join(' ') + '…' : o.summary.trim();
    return { pillar, summary };
  };
}
