// القواعد المشتركة (SPEC §10) وتهيئة ملفات config/*.md.
// الدوال هنا نقية (لا تستورد ملفات .md) حتى تُختبر مباشرة؛ الاستيراد يتم في src/content.ts.

/** من هو المالك وجمهوره (SPEC §10)؛ يُستعمل في القواعد المشتركة وفي بحث الأحداث. */
export const OWNER_PROFILE =
  'الكاتب محامٍ سعودي ومستشار في الحوكمة والتخطيط الاستراتيجي، والجمهور مهنيون وقياديون في القطاعين الخاص وغير الربحي.';

export const SHARED_RULES = `قواعد ثابتة لكل مهمة:
- ${OWNER_PROFILE}
- العربية الفصحى المعاصرة، رصينة وواضحة، بلا حشو ولا مبالغة ولا إيموجي كثيرة.
- يُمنع اختلاق أي رقم مادة نظامية أو اسم نظام أو إحصائية أو مصدر غير موجود في نص الفكرة. إذا احتاج المنشور مرجعاً غير متوفر، يُكتب بصيغة عامة، وتُضاف ملاحظة في حقل notes تطلب من المالك التحقق.
- لا يتضمن المنشور استشارة في قضية بعينها، ولا وعوداً بنتائج، ولا أي معلومة عن عملاء.
- يُلتزم بما في دليل الأسلوب (config/voice.md) من أسلوب ونماذج.
- أعد JSON فقط وفق المخطط المطلوب.`;

/** يحذف تعليقات HTML (تعليمات القالب) ويقلّص الأسطر الفارغة. */
export function stripComments(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** هل الملف فارغ فعلياً (لا شيء غير العناوين والتعليقات)؟ */
export function isEffectivelyEmpty(md: string): boolean {
  return stripComments(md)
    .split('\n')
    .every((line) => line.trim() === '' || /^#{1,6}\s/.test(line.trim()));
}

/**
 * أسماء المحاور من config/pillars.md: عناوين المستوى الثاني (## اسم المحور).
 * إن لم توجد عناوين، تُقرأ البنود العليا (- اسم المحور) احتياطاً.
 */
export function parsePillars(md: string): string[] {
  const lines = stripComments(md).split('\n').map((l) => l.trim());
  const clean = (s: string) => s.replace(/[*_`]/g, '').replace(/[:：].*$/, '').trim();
  let names = lines.filter((l) => /^##\s+/.test(l) && !/^###/.test(l)).map((l) => clean(l.replace(/^##\s+/, '')));
  if (names.length === 0) {
    names = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => clean(l.replace(/^[-*]\s+/, '')));
  }
  return [...new Set(names.filter((n) => n !== '' && n.length <= 60))];
}

export function voiceSection(voiceMd: string): string {
  if (isEffectivelyEmpty(voiceMd)) {
    return 'دليل الأسلوب (config/voice.md): لم يُعبّأ بعد. اكتب بأسلوب مهني رصين وفق القواعد أعلاه.';
  }
  return `دليل الأسلوب ونماذج من كتابات المالك (config/voice.md):\n<voice>\n${stripComments(voiceMd)}\n</voice>`;
}

export function pillarsSection(pillarsMd: string): string {
  if (isEffectivelyEmpty(pillarsMd)) return 'محاور المحتوى (config/pillars.md): لم تُعبّأ بعد.';
  return `محاور المحتوى (config/pillars.md):\n<pillars>\n${stripComments(pillarsMd)}\n</pillars>`;
}

/** تعليمات النظام لمهام الكتابة (draft/revise): ثابتة بين الاستدعاءات لتستفيد من التخزين المؤقت. */
export function writerSystemPrompt(voiceMd: string, pillarsMd: string): string {
  return [
    'أنت مساعد كتابة شخصي لمالك هذا البوت، تصوغ منشوراته على X ولينكدن وسكربتات سناب شات.',
    SHARED_RULES,
    voiceSection(voiceMd),
    pillarsSection(pillarsMd),
  ].join('\n\n');
}

/** تعليمات النظام للمهام الخفيفة (التصنيف والخطة): القواعد المشتركة والمحاور بلا نماذج الكتابة. */
export function assistantSystemPrompt(pillarsMd: string, role: string): string {
  return [role, SHARED_RULES, pillarsSection(pillarsMd)].join('\n\n');
}

/** يلف نص المستخدم بوسوم حتى لا يُخلط بالتعليمات. */
export function quote(tag: string, text: string): string {
  return `<${tag}>\n${text.trim()}\n</${tag}>`;
}
