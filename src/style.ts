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

/** العبارات الممنوعة التي ذكرها المالك بنصها في ملاحظاته (ولو بين علامات تنصيص)، فهو يريدها. */
export function requestedPhrases(notes: string): string[] {
  return bannedIn(notes.replace(/[«»"'“”‘’()[\]]/gu, ' '));
}

function hashtagCount(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/**
 * مخالفات الأسلوب في المسودة (كلها غير مانعة للنشر)، مجمّعة بحسب المنصة.
 * allowed: عبارات طلبها المالك بنصه في ملاحظاته، فلا تُعدّ مخالفة يُعاد الطلب بسببها.
 */
export function checkStyle(c: DraftContent, allowed: readonly string[] = []): Violation[] {
  const v: Violation[] = [];
  const parts: Array<[string, string]> = [
    ['X', c.x_segments.join('\n\n')],
    ['لينكدن', c.linkedin_text],
    ['سناب', c.snap_script.join('\n\n')],
  ];
  for (const [where, text] of parts) {
    const found = bannedIn(text).filter((f) => !allowed.includes(f));
    if (found.length) v.push({ hard: false, message: `عبارات ممنوعة في ${where}: ${found.map((f) => `«${f}»`).join('، ')}` });
    const tags = hashtagCount(text);
    if (tags > MAX_HASHTAGS) v.push({ hard: false, message: `وسوم ${where} ${tags} (الحد ${MAX_HASHTAGS})` });
  }
  return v;
}

/** كلمات نص مطبّع، وعلامات الترقيم والإيموجي تبقى ملتصقة بها حتى يُحسب حذفها تغييراً. */
function tokens(text: string): string[] {
  return normalizeArabic(text).split(/\s+/).filter(Boolean);
}

/** معامل Dice على أزواج الكلمات المتتالية بين نصين، من 0 إلى 1. */
function dice(a: string, b: string): number {
  const pairs = (w: string[]) => {
    const m = new Map<string, number>();
    if (w.length === 1) m.set(w[0] ?? '', 1);
    for (let i = 0; i < w.length - 1; i++) {
      const k = `${w[i]} ${w[i + 1]}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const pa = pairs(tokens(a));
  const pb = pairs(tokens(b));
  let total = 0;
  for (const n of pa.values()) total += n;
  for (const n of pb.values()) total += n;
  if (total === 0) return 1;
  let common = 0;
  for (const [k, n] of pa) common += Math.min(n, pb.get(k) ?? 0);
  return (2 * common) / total;
}

/**
 * تشابه نسختين من مسودة، من 0 إلى 1: تشابه المنصة التي تغيّرت أكثر من غيرها (X ولينكدن وسناب).
 * 1 تعني النص نفسه. يكشف التعديل الذي يعيد المسودة كما هي أو بتبديل كلمة أو كلمتين،
 * ولا يعدّ تعديلاً محصوراً في منصة واحدة أو تغريدة واحدة إعادةً للنص.
 */
export function similarity(a: DraftContent, b: DraftContent): number {
  return Math.min(
    dice(a.x_segments.join('\n'), b.x_segments.join('\n')),
    dice(a.linkedin_text, b.linkedin_text),
    dice(a.snap_script.join('\n'), b.snap_script.join('\n')),
  );
}
