// events — بحث الويب عن الأحداث لاقتراحات النشر (طلب المالك، NOTES.md القسم 11):
// أخبار محاور المالك في السعودية والخليج، والموضوعات العامة الرائجة إن أمكن ربطها بها.
// المخرج نص قصير مسنَد إلى مصادر من نتائج البحث (citations)، تحوّله الخطة إلى اقتراحات.
// الدوال هنا نقية حتى تُختبر مباشرة.

import { OWNER_PROFILE, pillarsSection, quote } from './shared.ts';

export const EVENTS_MAX_SEARCHES = 5;
export const EVENTS_MAX_TOKENS = 12_000;
export const EVENTS_MAX_SOURCES = 12;
const MAX_URL_LENGTH = 300;
const MAX_TITLE_LENGTH = 100;

/** يوجّه نتائج البحث إلى السعودية (user_location في أداة web_search). */
export const SEARCH_LOCATION = { type: 'approximate', country: 'SA', timezone: 'Asia/Riyadh' } as const;

export interface EventSource {
  url: string;
  title: string;
}

/** ملخص الأحداث؛ يشير نصه إلى مصادره بأرقامها [1] [2] بحسب ترتيبها في sources. */
export interface EventDigest {
  text: string;
  sources: EventSource[];
}

export function eventsSystem(pillarsMd: string): string {
  return [
    'أنت باحث أخبار لمالك هذا البوت، تبحث في الويب عمّا يستحق أن يكتب عنه الآن.',
    `المالك: ${OWNER_PROFILE}`,
    pillarsSection(pillarsMd),
    [
      'ابحث عن نوعين:',
      '- أخبار المحاور: أنظمة ولوائح وقرارات وتقارير ومبادرات وفعاليات مهنية في السعودية والخليج تخص محاور المالك أو تخصصه.',
      '- الرائج العام: موضوعات عامة رائجة في السعودية هذه الأيام، بشرط أن يمكن ربطها بأحد المحاور بزاوية مهنية؛ استبعد ما لا يمكن ربطه.',
      'ابحث بالعربية، وبالإنجليزية عند الحاجة.',
    ].join('\n'),
    [
      'الضوابط:',
      '- الأحداث من الفترة المحددة فقط، ومن نتائج البحث فقط. لا تذكر حدثاً من ذاكرتك، ولا تخمّن تاريخه.',
      '- من 3 إلى 6 أحداث مرتبة بالأهمية. لكل حدث سطر واحد يبدأ بـ «- »: ما حدث، وتاريخه، ولماذا يهم جمهور المالك.',
      '- إن لم تجد ما يستحق فاكتب: لا جديد مهم.',
      '- بلا مقدمة ولا خاتمة ولا عناوين.',
    ].join('\n'),
  ].join('\n\n');
}

export function eventsUser(today: string, since: string, avoid: string[]): string {
  return [
    `اليوم: ${today}. ابحث عن أحداث الفترة من ${since} حتى اليوم.`,
    avoid.length ? `أحداث اقتُرحت على المالك مؤخراً، لا تكررها:\n${quote('avoid', avoid.map((t) => `- ${t}`).join('\n'))}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** كتلة من رد Anthropic كما تصل: نص بمصادره، أو استدعاء أداة، أو نتائجها، أو تفكير. */
export interface ResponseBlock {
  type: string;
  text?: string;
  citations?: Array<{ type?: string; url?: string; title?: string }> | null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * يبني الملخص من الإجابة النهائية: كتل النص بعد آخر كتلة غير نصية (بحث أو نتائجه أو تفكير)،
 * مع أرقام مصادرها [n] في آخر كل جزء مسنَد. المصادر من citations وحدها، أي روابط من نتائج البحث
 * فعلاً، بلا تكرار وبحد أقصى. إن لم يُسنَد شيء (مثل «لا جديد مهم») يعيد null.
 */
export function buildDigest(blocks: ResponseBlock[]): EventDigest | null {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type !== 'text') start = i + 1;
  });
  const sources: EventSource[] = [];
  const numbers = new Map<string, number>();
  let text = '';
  for (const b of blocks.slice(start)) {
    if (typeof b.text !== 'string' || !b.text) continue;
    const refs = new Set<number>();
    for (const c of Array.isArray(b.citations) ? b.citations : []) {
      const url = c?.url;
      if (c?.type !== 'web_search_result_location' || typeof url !== 'string') continue;
      if (!/^https?:\/\//.test(url) || url.length > MAX_URL_LENGTH) continue;
      let n = numbers.get(url);
      if (n === undefined) {
        if (sources.length >= EVENTS_MAX_SOURCES) continue;
        const title = (typeof c.title === 'string' ? c.title : '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
        sources.push({ url, title: title || hostOf(url) });
        n = sources.length;
        numbers.set(url, n);
      }
      refs.add(n);
    }
    // الأرقام قبل الأسطر الفارغة في آخر الكتلة حتى تبقى على سطر الحدث نفسه
    const body = b.text.replace(/\s+$/, '');
    const tail = b.text.slice(body.length);
    text += body + (refs.size ? ` ${[...refs].map((n) => `[${n}]`).join('')}` : '') + tail;
  }
  text = text.trim();
  if (!sources.length || !text) return null;
  return { text, sources };
}
