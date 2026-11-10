// مدقّق الأسلوب: مراجعة ثانية للمسودة بقائمة أسئلة مأخوذة من دليل الأسلوب (config/voice.md).
// الفحص الآلي في src/style.ts يكشف العبارات بلفظها؛ هذا يكشف ما لا يُكشف بلفظ: غياب الموقف والمثال،
// والتعميم، والخاتمة الملخّصة، والتراكيب الآلية. لكل بند جواب نعم/لا واقتباس يثبته.

import type { ClaudeMessage } from '../claude.ts';
import type { DraftContent } from '../text.ts';
import { OWNER_PROFILE, quote, voiceSection } from './shared.ts';

export const REVIEW_MAX_TOKENS = 2048;

export interface ReviewCriterion {
  id: string;
  /** اسم قصير يظهر للمالك في المعاينة. */
  label: string;
  /** السؤال كما يُطرح على المدقّق. */
  question: string;
}

// بالترتيب الذي يظهر في المعاينة. عند تعديل قسم «بناء المنشور» أو «الممنوعات» في دليل الأسلوب راجع هذه القائمة.
export const REVIEW_CRITERIA: readonly ReviewCriterion[] = [
  {
    id: 'stance',
    label: 'موقف واضح',
    question: 'هل للمنشور موقف واحد واضح يمكن تلخيصه في جملة، لا حياد يعرض الأطراف دون أن يقول شيئاً؟',
  },
  {
    id: 'practice',
    label: 'مثال من الممارسة',
    question:
      'هل فيه تفصيلة ملموسة من الممارسة (موقف في مجلس إدارة، بند في لائحة، خطأ متكرر في خطة، قصة صغيرة)، لا تعميم مجرد فقط؟',
  },
  {
    id: 'specific',
    label: 'خاص بالمجال',
    question:
      'هل الفكرة والنصيحة خاصة بالحوكمة أو القانون أو التخطيط الاستراتيجي، أي لا تصلح كما هي لأي مهنة أخرى بتبديل كلمة؟',
  },
  {
    id: 'opening',
    label: 'افتتاحية مباشرة',
    question:
      'هل تدخل التغريدة الأولى وأول سطر في لينكدن في الفكرة مباشرة بموقف أو مشاهدة أو مفارقة، بلا سؤال بلاغي ولا تمهيد عام ولا عبارة تشويق؟',
  },
  {
    id: 'ending',
    label: 'خاتمة بلا تلخيص',
    question:
      'هل ينتهي المنشور (في X ولينكدن) حين تنتهي الفكرة، بلا خلاصة تكرر ما سبق ولا دعوة للتفاعل ولا سؤال مصطنع؟',
  },
  {
    id: 'constructions',
    label: 'بلا تراكيب آلية',
    question:
      'هل يخلو النص من التراكيب الآلية: ثلاث صفات أو أفعال متتالية متكررة، والموازنة المصطنعة (من جهة… ومن جهة أخرى، سواء كان… أو…)، والمفردات المنتفخة، والجمل التي تصلح لأي منشور؟',
  },
  {
    id: 'voice',
    label: 'صوت الممارس',
    question:
      'هل يُقرأ النص كممارس خبير يحدّث زملاءه بثقة هادئة، بجمل متفاوتة الطول ولغة تناسب المنصة (بيضاء رسمية في X وسناب، فصحى في لينكدن)، لا كناشر محتوى يعظ أو يسوّق؟',
  },
];

const criterionSchema = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['pass', 'evidence'],
  additionalProperties: false,
};

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    checks: {
      type: 'object',
      properties: Object.fromEntries(REVIEW_CRITERIA.map((c) => [c.id, criterionSchema])),
      required: REVIEW_CRITERIA.map((c) => c.id),
      additionalProperties: false,
    },
  },
  required: ['checks'],
  additionalProperties: false,
};

export interface ReviewCheck {
  id: string;
  label: string;
  pass: boolean;
  evidence: string;
}

/** نتيجة المدقّق كما تُحفظ مع المسودة (عمود style_review). */
export interface StyleReview {
  passed: number;
  total: number;
  /** البنود الساقطة فقط، بترتيب REVIEW_CRITERIA. */
  failed: ReviewCheck[];
}

export function parseReview(raw: unknown): StyleReview {
  const checks = (raw as { checks?: Record<string, { pass?: unknown; evidence?: unknown }> } | null)?.checks;
  if (!checks || typeof checks !== 'object') throw new Error('checks missing');
  const all: ReviewCheck[] = REVIEW_CRITERIA.map((c) => {
    const r = checks[c.id];
    if (!r || typeof r.pass !== 'boolean') throw new Error(`check ${c.id} missing`);
    return { id: c.id, label: c.label, pass: r.pass, evidence: typeof r.evidence === 'string' ? r.evidence.trim() : '' };
  });
  return { passed: all.filter((c) => c.pass).length, total: all.length, failed: all.filter((c) => !c.pass) };
}

/** تعليمات النظام للمدقّق: ثابتة بين الاستدعاءات (تُخزَّن مؤقتاً). */
export function reviewSystemPrompt(voiceMd: string): string {
  return [
    'أنت مدقّق أسلوب صارم لمنشورات كاتب بعينه. مهمتك أن تحكم هل المسودة مكتوبة بصوته وفق دليل أسلوبه، أم أنها كتابة عامة تشبه النص المولّد آلياً.',
    `- ${OWNER_PROFILE}`,
    '- لا تجامل. إذا تردّدت في بند فجوابه لا. البند ينجح فقط إن تحقق في X ولينكدن كليهما.',
    '- evidence: عند النجاح اقتبس العبارة التي تثبته. عند السقوط اقتبس الجملة المخالفة بنصها، أو اذكر ما ينقص بجملة واحدة إن كان السقوط غياباً (مثل غياب المثال). لا تتجاوز 200 حرف.',
    '- لا تقترح صياغة بديلة، ولا تحكم على صحة المعلومات النظامية؛ حكمك على الأسلوب وحده.',
    voiceSection(voiceMd),
    'أعد JSON فقط وفق المخطط المطلوب.',
  ].join('\n\n');
}

export function reviewUser(c: DraftContent): string {
  const questions = REVIEW_CRITERIA.map((r) => `- ${r.id}: ${r.question}`).join('\n');
  const draft = [
    `X (ثريد):\n${c.x_segments.map((s, i) => `${i + 1}/ ${s}`).join('\n\n')}`,
    `لينكدن:\n${c.linkedin_text}`,
    `سناب شات:\n${c.snap_script.join('\n---\n')}`,
  ].join('\n\n');
  return [`المسودة:\n${quote('draft', draft)}`, `أجب عن كل بند بـ pass و evidence:\n${questions}`].join('\n\n');
}

/** دورة محادثة تالية للمسودة التي سقطت في المراجعة: البنود الساقطة بأدلتها، وما نجح يبقى. */
export function reviewFixTurn(previous: DraftContent, review: StyleReview): ClaudeMessage[] {
  const failed = review.failed.map((f) => {
    const q = REVIEW_CRITERIA.find((c) => c.id === f.id)?.question ?? f.label;
    return `- ${f.label}: ${q}\n  ملاحظة المدقّق: ${f.evidence || 'لا يتحقق'}`;
  });
  return [
    { role: 'assistant', content: JSON.stringify(previous) },
    {
      role: 'user',
      content: [
        'راجع مدقّق الأسلوب المسودة وفق دليل الأسلوب، فسقطت في البنود التالية:',
        failed.join('\n'),
        'أعد المسودة كاملة بالمخطط نفسه بعد إصلاح هذه البنود. أعد كتابة الجمل المذكورة نفسها، ولا تكتفِ بتبديل كلمة بمرادفها. أبقِ الفكرة والمعلومات وما لم يُذكر كما هو، والتزم بمواصفات المخرجات وحدود الطول. لا تختلق مثالاً فيه رقم أو جهة أو واقعة محددة غير موجودة في الفكرة: المثال من الممارسة يكون عاماً لا يكشف جهة.',
      ].join('\n'),
    },
  ];
}

/** سطر المعاينة: «🧭 الأسلوب: 5/7، لم يتحقق: …». */
export function reviewLine(r: StyleReview): string {
  if (r.failed.length === 0) return `🧭 الأسلوب: ${r.passed}/${r.total}`;
  return `🧭 الأسلوب: ${r.passed}/${r.total}، لم يتحقق: ${r.failed.map((f) => f.label).join('، ')}`;
}
