// draft — SPEC §10: المدخل الفكرة والمحور وآخر 5 منشورات منشورة، والمخرج مخطط المسودة.

import { truncate, type DraftContent, type Violation } from '../text.ts';
import { quote } from './shared.ts';
import type { ClaudeMessage } from '../claude.ts';

export const DRAFT_MAX_TOKENS = 4096;

// المخطط نفسه لـ draft و revise (SPEC §10).
export const DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    x_segments: { type: 'array', items: { type: 'string' } },
    linkedin_text: { type: 'string' },
    snap_script: { type: 'array', items: { type: 'string' } },
    needs_visual: { type: 'boolean' },
    visual_brief: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['x_segments', 'linkedin_text', 'snap_script', 'needs_visual', 'visual_brief', 'notes'],
  additionalProperties: false,
};

export const FORMAT_RULES = `مواصفات المخرجات:
- x_segments: ثريد من 1 إلى 6 تغريدات بحسب ما تحتاجه الفكرة فعلاً، الأولى خطّاف قوي يستوقف القارئ. كل تغريدة لا تتجاوز 260 حرفاً (حد X هو 280، ويُحسب الرابط 23 حرفاً والإيموجي حرفين). لا تكتب ترقيماً مثل «1/» داخل النص، فالبوت يرقّم التغريدات عند العرض.
- linkedin_text: من 120 إلى 300 كلمة، بافتتاحية جاذبة وفقرات قصيرة، وخاتمة بسؤال أو خلاصة، ولا يتجاوز 3000 حرف.
- snap_script: من 3 إلى 5 إطارات لسناب شات، كل إطار سطران كحد أقصى (افصل السطرين بسطر جديد).
- needs_visual: true إذا كان تصميم مرئي (بطاقة أو مخطط) سيضيف قيمة واضحة للمنشور.
- visual_brief: وصف مختصر للتصميم المقترح ليُصمَّم في Claude Design إذا كان needs_visual صحيحاً، وإلا null.
- notes: ملاحظات للمالك (مثل مرجع يحتاج تحققاً)، أو null.`;

export interface IdeaInput {
  id: number;
  text: string;
  pillar: string | null;
}

export interface RecentPost {
  first_tweet: string;
}

function recentSection(recent: RecentPost[]): string {
  if (recent.length === 0) return 'آخر المنشورات المنشورة: لا يوجد بعد.';
  const lines = recent.map((p) => `- ${truncate(p.first_tweet, 160)}`);
  return `آخر المنشورات المنشورة (تجنّب تكرار زواياها وافتتاحياتها):\n${lines.join('\n')}`;
}

function ideaSection(idea: IdeaInput): string {
  return `المحور: ${idea.pillar ?? 'غير مصنّف'}\n\nالفكرة (#${idea.id}):\n${quote('idea', idea.text)}`;
}

export function draftUser(idea: IdeaInput, recent: RecentPost[], angle?: string): string {
  return [
    'المهمة: صياغة منشور جديد من فكرة المالك.',
    ideaSection(idea),
    angle ? `الزاوية المقترحة من خطة النشر:\n${quote('angle', angle)}` : '',
    recentSection(recent),
    FORMAT_RULES,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 🔁 صياغة جديدة: من الصفر وبزاوية مختلفة عن النسخة الحالية (SPEC §7). */
export function regenerateUser(idea: IdeaInput, previous: DraftContent, recent: RecentPost[]): string {
  return [
    'المهمة: صياغة جديدة من الصفر للفكرة نفسها بزاوية مختلفة عن النسخة السابقة، لا تعديلاً عليها.',
    ideaSection(idea),
    `النسخة السابقة (لا تكرر زاويتها ولا افتتاحيتها):\n${quote(
      'previous',
      `X: ${truncate(previous.x_segments[0] ?? '', 280)}\nLinkedIn: ${truncate(previous.linkedin_text, 300)}`,
    )}`,
    recentSection(recent),
    FORMAT_RULES,
  ].join('\n\n');
}

/** إعادة الطلب مرة واحدة مع ذكر الخطأ (SPEC §10 قيود X)، كدورة محادثة تالية للمخرجات المخالفة. */
export function fixViolationsTurn(previous: DraftContent, violations: Violation[]): ClaudeMessage[] {
  return [
    { role: 'assistant', content: JSON.stringify(previous) },
    {
      role: 'user',
      content: [
        'خالفت المسودة القيود التالية:',
        violations.map((v) => `- ${v.message}`).join('\n'),
        'أعد المسودة كاملة بالمخطط نفسه بعد تصحيح هذه المخالفات فقط، واختصر أي تغريدة طويلة دون أن تغيّر معناها.',
      ].join('\n'),
    },
  ];
}
