// revise — SPEC §10: المدخل المسودة الحالية وملاحظات المالك بنصها، والمخرج نفس مخطط draft.
// الملاحظات تُنفَّذ تنفيذاً ظاهراً: إعادة المسودة كما هي خطأ يكشفه البوت (similarity في src/style.ts).

import type { DraftContent } from '../text.ts';
import { FORMAT_RULES, type IdeaInput } from './draft.ts';
import { quote } from './shared.ts';

export const REVISE_RULES = `المهمة: عدّل المسودة الحالية وفق ملاحظات المالك، وأعد المسودة كاملة بالمخطط نفسه.
- نفّذ كل ما في الملاحظات تنفيذاً يظهر في النص. إعادة المسودة كما هي، أو بتبديل كلمة بمرادفها، خطأ.
- إذا كانت الملاحظات عن الصياغة أو الأسلوب أو أن النص يبدو مكتوباً آلياً، فأعد كتابة كل جملة بعبارة جديدة وفق دليل الأسلوب، وأبقِ الفكرة والمعلومات كما هي. ابدأ بافتتاحية مختلفة، وغيّر بناء الجمل لا مفرداتها فقط.
- إذا حددت الملاحظات موضعاً (الافتتاحية، أو تغريدة بعينها، أو منصة واحدة)، فعدّله وأبقِ ما عداه.
- إذا لم تحدد الملاحظات منصة، فهي تنطبق على X ولينكدن وسناب جميعاً.
- كل ما تكتبه أو تعيد كتابته يلتزم بدليل الأسلوب، وخاصة قسم «عبارات وعادات ممنوعة».`;

/** حد ما يُعرض من الملاحظات السابقة على المسودة نفسها. */
export const REVISE_HISTORY_MAX = 5;

export function reviseUser(
  idea: IdeaInput | null,
  current: DraftContent,
  ownerNotes: string,
  previousNotes: readonly string[] = [],
): string {
  const draftJson = JSON.stringify(
    {
      x_segments: current.x_segments,
      linkedin_text: current.linkedin_text,
      snap_script: current.snap_script,
      needs_visual: current.needs_visual,
      visual_brief: current.visual_brief,
      notes: current.notes,
    },
    null,
    2,
  );
  const history = previousNotes.length
    ? `ملاحظات سابقة من المالك على هذه المسودة (المسودة الحالية نتيجتها، وعودته بملاحظات جديدة تعني أنها لم تُرضه بعد):\n${quote(
        'previous_notes',
        previousNotes.map((n, i) => `${i + 1}. ${n}`).join('\n'),
      )}`
    : '';
  return [
    REVISE_RULES,
    idea ? `المحور: ${idea.pillar ?? 'غير مصنّف'}\n\nالفكرة الأصلية (#${idea.id}):\n${quote('idea', idea.text)}` : '',
    `المسودة الحالية:\n${quote('draft', draftJson)}`,
    history,
    `ملاحظات المالك (بنصها):\n${quote('owner_notes', ownerNotes)}`,
    FORMAT_RULES,
  ]
    .filter(Boolean)
    .join('\n\n');
}
