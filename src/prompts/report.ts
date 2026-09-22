// report — SPEC §10: المدخل مقاييس منشورات آخر 30 يوماً (إعجابات، تعليقات، مشاركات، حفظ)،
// والمخرج { "headline", "top_post", "insight", "next_week_tip" }.
// لا يُستنتج ما لا تدعمه الأرقام، وإذا كانت البيانات قليلة يُذكر ذلك صراحة.

import type { PillarStat, PostPerformance } from '../analytics.ts';
import { postsAr, truncate } from '../text.ts';
import { formatRiyadhDate, parseUtc } from '../time.ts';
import { assistantSystemPrompt, quote } from './shared.ts';

export const REPORT_MAX_TOKENS = 1024;
/** أقل من هذا العدد من المنشورات المقيسة تُعد البيانات قليلة. */
export const LOW_DATA_THRESHOLD = 3;

export const REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    top_post: { type: 'string' },
    insight: { type: 'string' },
    next_week_tip: { type: 'string' },
  },
  required: ['headline', 'top_post', 'insight', 'next_week_tip'],
  additionalProperties: false,
};

export interface ReportResult {
  headline: string;
  top_post: string;
  insight: string;
  next_week_tip: string;
}

export function reportSystem(pillarsMd: string): string {
  return assistantSystemPrompt(
    pillarsMd,
    'مهمتك كتابة تقرير أداء أسبوعي قصير لمنشورات المالك، اعتماداً على الأرقام المعطاة وحدها.',
  );
}

const value = (v: number | null) => (v === null ? 'غير متوفر' : String(v));

function postLine(p: PostPerformance): string {
  const metrics = p.platforms.length
    ? p.platforms
        .map((m) => `${m.platform}: إعجابات ${value(m.likes)}، تعليقات ${value(m.comments)}، مشاركات ${value(m.shares)}، حفظ ${value(m.saves)}`)
        .join(' | ')
    : p.failed
      ? 'تعذّر جلب المقاييس'
      : 'لا مقاييس';
  const date = formatRiyadhDate(parseUtc(p.published_at));
  return `- #${p.draft_id} [${p.pillar ?? 'غير مصنّف'}] ${date}: «${truncate(p.title, 120)}» — ${metrics} — المجموع: ${value(p.total)}`;
}

export function reportUser(today: string, items: PostPerformance[], stats: PillarStat[]): string {
  const measured = items.filter((i) => i.total !== null);
  const top = [...measured].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  const pillarLines = stats
    .map((s) => `- ${s.pillar}: ${postsAr(s.posts)}، منها ${s.measured} بمقاييس، متوسط التفاعل ${s.avg === null ? 'غير متوفر' : s.avg}`)
    .join('\n');
  return [
    `اليوم: ${today}. الفترة: آخر 30 يوماً. التفاعل = إعجابات + تعليقات + مشاركات + حفظ.`,
    `المنشورات (${items.length}):\n${quote('data', items.map(postLine).join('\n'))}`,
    `أداء المحاور:\n${quote('pillars', pillarLines)}`,
    top ? `أعلى منشور تفاعلاً وفق الأرقام: #${top.draft_id} بمجموع ${top.total}.` : '',
    measured.length < LOW_DATA_THRESHOLD
      ? `البيانات قليلة (${measured.length} من المنشورات فقط بمقاييس متاحة): اذكر ذلك صراحة، ولا تعمّم ولا تقارن مقارنات لا تحتملها الأرقام.`
      : '',
    [
      'الضوابط:',
      '- لا تستنتج ما لا تدعمه الأرقام، ولا تختلق أسباباً أو أرقاماً أو مقارنات بفترات سابقة.',
      '- «غير متوفر» يعني أن المنصة لم تُرجع الرقم، وليس صفراً.',
      '- headline: جملة واحدة تلخّص أداء الفترة.',
      '- top_post: سطر يذكر أفضل منشور برقمه وعنوانه المختصر وما يميّزه في الأرقام فقط.',
      '- insight: ملاحظة واحدة مدعومة بالأرقام.',
      '- next_week_tip: توصية عملية واحدة للأسبوع القادم تنبع من الأرقام.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseReport(raw: unknown): ReportResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = (k: keyof ReportResult) => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`report.${k}`);
    return v.trim();
  };
  return { headline: pick('headline'), top_post: pick('top_post'), insight: pick('insight'), next_week_tip: pick('next_week_tip') };
}
