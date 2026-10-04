// فحص أسلوبي بعد التوليد: عبارات وعادات تكشف النص المولّد آلياً (config/voice.md، قسم الممنوعات).
// لا يمنع النشر؛ يُعاد الطلب مرة واحدة عند المخالفة، وما بقي يظهر تنبيهاً في المعاينة.

import type { DraftContent, Violation } from './text.ts';

interface StylePattern {
  /** ما يظهر للمالك وللنموذج عند المخالفة. */
  label: string;
  /** يُطابَق على النص بعد التطبيع (بلا تشكيل ولا تطويل، والهمزات على الألف ألفاً). */
  re: RegExp;
}

// الأنماط مكتوبة بصيغة مطبّعة: «اليك» لا «إليك»، و«دورا» لا «دوراً».
// كلمات مثل «جوهري» و«القيمة المضافة» ليست هنا عمداً لأنها مصطلحات نظامية.
export const BANNED_PATTERNS: readonly StylePattern[] = [
  // افتتاحيات
  { label: 'في عالم اليوم', re: /في عالم(نا)? (اليوم|المتسارع|متسارع)/u },
  { label: 'في ظل التحولات', re: /في ظل (التحولات|التغيرات|التطورات|المتغيرات)/u },
  { label: 'هل تساءلت يوماً', re: /هل تساءلت/u },
  { label: 'لا شك أن', re: /لا شك (ان|في)/u },
  { label: 'من المهم أن نشير', re: /من المهم ان (نشير|نذكر|نؤكد)|من الجدير بالذكر/u },
  { label: 'دعونا نستكشف', re: /دعونا (نستكشف|نتعرف|نتامل|نلقي)/u },
  { label: 'إليك أهم…', re: /(^|\s)اليك (اهم|\d|[٠-٩])/u },
  { label: 'في هذا المنشور', re: /في هذا (المنشور|الثريد|المقال)/u },
  // خواتيم
  { label: 'في الختام', re: /(^|\s)(و|ف)?(في الختام|ختاما|خلاصه القول|خلاصة القول)/u },
  { label: 'شاركونا / ما رأيكم؟', re: /شاركونا|ما رايكم/u },
  { label: 'لا تنسَ المتابعة', re: /لا تنس[ىي]? (المتابعه|المتابعة|متابعتي)/u },
  // مفردات منتفخة
  { label: 'محوري', re: /محوري/u },
  { label: 'حجر الزاوية', re: /حجر الزاويه|حجر الزاوية/u },
  { label: 'نقلة نوعية', re: /نقله نوعيه|نقلة نوعية/u },
  { label: 'يلعب دوراً حيوياً', re: /(يلعب|تلعب|يلعبون)( \S+){0,2} دورا/u },
  { label: 'منظومة متكاملة', re: /منظومه متكامله|منظومة متكاملة/u },
  { label: 'آفاق رحبة', re: /افاق (رحبه|رحبة|واسعه|واسعة|جديده|جديدة)/u },
  { label: 'الارتقاء بـ', re: /الارتقاء ب/u },
  { label: 'تعزيز وتمكين', re: /تعزيز و ?تمكين|تمكين و ?تعزيز/u },
  { label: 'بيئة محفزة', re: /بيئه محفزه|بيئة محفزة/u },
  // تراكيب
  { label: 'ليس مجرد… بل', re: /(ليس|ليست|لم يعد|لم تعد|ليسوا) مجرد/u },
  { label: 'من جهة أخرى', re: /(من|و ?من) (جهه|جهة|ناحيه|ناحية) اخر[ىي]/u },
  // شكل
  { label: 'الشَّرطة الطويلة (—)', re: /—/u },
  { label: 'خط عريض (**)', re: /\*\*/u },
  { label: 'سطر يبدأ بإيموجي', re: /^\s*\p{RGI_Emoji}/mv },
];

const MAX_HASHTAGS = 2;

/** يطبّع النص العربي للمطابقة: يحذف التشكيل والتطويل، ويوحّد الألف. */
export function normalizeArabic(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[ً-ْٰـ]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا');
}

/** العبارات الممنوعة الموجودة في نص واحد، بأسمائها، بلا تكرار. */
export function bannedIn(text: string): string[] {
  const t = normalizeArabic(text);
  return BANNED_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.label);
}

function hashtagCount(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** مخالفات الأسلوب في المسودة (كلها غير مانعة للنشر)، مجمّعة بحسب المنصة. */
export function checkStyle(c: DraftContent): Violation[] {
  const v: Violation[] = [];
  const parts: Array<[string, string]> = [
    ['X', c.x_segments.join('\n\n')],
    ['لينكدن', c.linkedin_text],
    ['سناب', c.snap_script.join('\n\n')],
  ];
  for (const [where, text] of parts) {
    const found = bannedIn(text);
    if (found.length) v.push({ hard: false, message: `عبارات ممنوعة في ${where}: ${found.map((f) => `«${f}»`).join('، ')}` });
    const tags = hashtagCount(text);
    if (tags > MAX_HASHTAGS) v.push({ hard: false, message: `وسوم ${where} ${tags} (الحد ${MAX_HASHTAGS})` });
  }
  return v;
}
