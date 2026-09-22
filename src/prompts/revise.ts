// revise — SPEC §10: المدخل المسودة الحالية وملاحظات المالك بنصها، والمخرج نفس مخطط draft.
// يُعدَّل فقط ما تطلبه الملاحظات.

import type { DraftContent } from '../text.ts';
import { FORMAT_RULES, type IdeaInput } from './draft.ts';
import { quote } from './shared.ts';

export function reviseUser(idea: IdeaInput | null, current: DraftContent, ownerNotes: string): string {
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
  return [
    'المهمة: عدّل المسودة الحالية وفق ملاحظات المالك. غيّر فقط ما تطلبه الملاحظات، وأبقِ ما عداه كما هو قدر الإمكان، وأعد المسودة كاملة بالمخطط نفسه.',
    idea ? `المحور: ${idea.pillar ?? 'غير مصنّف'}\n\nالفكرة الأصلية (#${idea.id}):\n${quote('idea', idea.text)}` : '',
    `المسودة الحالية:\n${quote('draft', draftJson)}`,
    `ملاحظات المالك (بنصها):\n${quote('owner_notes', ownerNotes)}`,
    FORMAT_RULES,
  ]
    .filter(Boolean)
    .join('\n\n');
}
