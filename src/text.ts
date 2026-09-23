// قيود المحتوى والتحقق البرمجي منها بعد التوليد (SPEC §10).

export const X_MAX_WEIGHTED = 280; // حد X للحساب العادي
export const X_MIN_TWEETS = 1;
export const X_MAX_TWEETS = 6;
export const LINKEDIN_MIN_WORDS = 120;
export const LINKEDIN_MAX_WORDS = 300;
export const LINKEDIN_MAX_CHARS = 3000; // حد لينكدن لنص المنشور
export const SNAP_MIN_FRAMES = 3;
export const SNAP_MAX_FRAMES = 5;
export const SNAP_MAX_LINES = 2;

// أوزان twitter-text (الإصدار 3) التي يحسب بها X طول التغريدة:
// النطاقات أدناه (ومنها العربية) بوزن حرف واحد، وما عداها بوزن حرفين،
// وكل رابط = 23 حرفاً، وكل إيموجي = حرفان.
const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const URL_RE = /https?:\/\/[^\s]+/giu;
const EMOJI_RE = /\p{RGI_Emoji}/gv;

export function xWeightedLength(text: string): number {
  let rest = text.normalize('NFC');
  let weight = 0;
  rest = rest.replace(URL_RE, () => {
    weight += 23;
    return '';
  });
  rest = rest.replace(EMOJI_RE, () => {
    weight += 2;
    return '';
  });
  for (const ch of rest) {
    const cp = ch.codePointAt(0) ?? 0;
    weight += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return weight;
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function countLines(text: string): number {
  return text.split(/\r?\n/u).filter((l) => l.trim() !== '').length;
}

export interface DraftContent {
  x_segments: string[];
  linkedin_text: string;
  snap_script: string[];
  needs_visual: boolean;
  visual_brief: string | null;
  notes: string | null;
}

export class ShapeError extends Error {}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const optString = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** يتحقق من بنية مخرجات draft/revise (نفس المخطط) ويرميها ShapeError إن خالفت. */
export function parseDraftContent(raw: unknown): DraftContent {
  if (!raw || typeof raw !== 'object') throw new ShapeError('not an object');
  const o = raw as Record<string, unknown>;
  if (!isStringArray(o.x_segments)) throw new ShapeError('x_segments');
  if (typeof o.linkedin_text !== 'string') throw new ShapeError('linkedin_text');
  if (!isStringArray(o.snap_script)) throw new ShapeError('snap_script');
  if (typeof o.needs_visual !== 'boolean') throw new ShapeError('needs_visual');
  const x = o.x_segments.map((s) => s.trim()).filter((s) => s !== '');
  const linkedin = o.linkedin_text.trim();
  if (x.length === 0 || linkedin === '') throw new ShapeError('empty content');
  return {
    x_segments: x,
    linkedin_text: linkedin,
    snap_script: o.snap_script.map((s) => s.trim()).filter((s) => s !== ''),
    needs_visual: o.needs_visual,
    visual_brief: optString(o.visual_brief),
    notes: optString(o.notes),
  };
}

export interface Violation {
  /** hard: يمنع النشر (يرفضه X أو لينكدن). soft: خروج عن المواصفات يُنبَّه إليه فقط. */
  hard: boolean;
  message: string;
}

export function checkDraftLimits(c: DraftContent): Violation[] {
  const v: Violation[] = [];
  const n = c.x_segments.length;
  if (n < X_MIN_TWEETS || n > X_MAX_TWEETS) {
    v.push({ hard: n > X_MAX_TWEETS, message: `عدد تغريدات الثريد ${n} (المطلوب ${X_MIN_TWEETS} إلى ${X_MAX_TWEETS})` });
  }
  c.x_segments.forEach((t, i) => {
    const len = xWeightedLength(t);
    if (len > X_MAX_WEIGHTED) {
      v.push({ hard: true, message: `التغريدة ${i + 1} طولها ${len} حرفاً والحد ${X_MAX_WEIGHTED}` });
    }
  });
  const chars = c.linkedin_text.length;
  if (chars > LINKEDIN_MAX_CHARS) {
    v.push({ hard: true, message: `نص لينكدن ${chars} حرفاً والحد ${LINKEDIN_MAX_CHARS}` });
  }
  const words = countWords(c.linkedin_text);
  if (words < LINKEDIN_MIN_WORDS || words > LINKEDIN_MAX_WORDS) {
    v.push({ hard: false, message: `نص لينكدن ${words} كلمة (المطلوب ${LINKEDIN_MIN_WORDS} إلى ${LINKEDIN_MAX_WORDS})` });
  }
  const frames = c.snap_script.length;
  if (frames < SNAP_MIN_FRAMES || frames > SNAP_MAX_FRAMES) {
    v.push({ hard: false, message: `سكربت سناب ${frames} إطارات (المطلوب ${SNAP_MIN_FRAMES} إلى ${SNAP_MAX_FRAMES})` });
  }
  c.snap_script.forEach((f, i) => {
    const lines = countLines(f);
    if (lines > SNAP_MAX_LINES) {
      v.push({ hard: false, message: `إطار سناب ${i + 1} فيه ${lines} أسطر (الحد ${SNAP_MAX_LINES})` });
    }
  });
  return v;
}

/** أطول تغريدة تتجاوز الحد تمنع النشر على X حتى لو اجتازت بقية الفحوص. */
export function xTooLong(segments: string[]): number[] {
  return segments.flatMap((t, i) => (xWeightedLength(t) > X_MAX_WEIGHTED ? [i + 1] : []));
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** «يوم واحد»، «يومان»، «4 أيام»، «11 يوماً». */
export function daysAr(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

/** «مسودة واحدة جاهزة»، «مسودتان جاهزتان»، «4 مسودات جاهزة»، «11 مسودة جاهزة». */
export function readyDraftsAr(n: number): string {
  if (n === 1) return 'مسودة واحدة جاهزة';
  if (n === 2) return 'مسودتان جاهزتان';
  if (n >= 3 && n <= 10) return `${n} مسودات جاهزة`;
  return `${n} مسودة جاهزة`;
}

/** «منشور واحد»، «منشوران»، «4 منشورات»، «11 منشوراً». */
export function postsAr(n: number): string {
  if (n === 1) return 'منشور واحد';
  if (n === 2) return 'منشوران';
  if (n >= 3 && n <= 10) return `${n} منشورات`;
  return `${n} منشوراً`;
}
