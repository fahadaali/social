// مقاييس أداء المنشورات (SPEC §8 المقاييس، §10 report، §12 المرحلة 3).
// الرقم الذي لا تُرجعه المنصة يبقى «غير متوفر» (null) ولا يُحسب صفراً، حتى لا يُستنتج ما لا تدعمه الأرقام.

import type { Ctx } from './context.ts';
import { getJsonState, publishedSince, setState, STATE_KEYS } from './db.ts';
import { PLATFORM_LABEL } from './env.ts';
import { loadLinkedInMetrics, type LinkedInMetricsRow } from './linkedin.ts';
import {
  BATCH_METRICS_MAX,
  describeTargetError,
  getPostMetrics,
  getPostsMetrics,
  platformName,
  readEngagement,
  SocialApiError,
  type Engagement,
  type PostTarget,
} from './socialapi.ts';
import { postsAr, truncate } from './text.ts';
import { formatRiyadhDate, parseUtc, toSqlUtc } from './time.ts';

export const REPORT_WINDOW_DAYS = 30;
const METRICS_CONCURRENCY = 4;

export interface PlatformPerformance extends Engagement {
  platform: string;
  permalink?: string | undefined;
  /** سبب غياب الأرقام كما أرجعته SocialAPI في targets[].error، إن وُجد. */
  note?: string | undefined;
  /** لينكدن فقط (من الأرقام المحفوظة): مرات الظهور والمشاهدات الفريدة، خارج مجموع التفاعل. */
  impressions?: number | null | undefined;
  unique_views?: number | null | undefined;
}

export const LINKEDIN_NOT_SYNCED_NOTE = 'لا أرقام متاحة له من لينكدن';

/**
 * يستبدل هدف لينكدن (مسار المقاييس الحية لا يدعمه) بالأرقام المحفوظة من LinkedIn Insights.
 * المنشور على لينكدن بلا أرقام محفوظة يظهر بسبب واضح بدل «غير مدعوم».
 */
export function withLinkedIn(platforms: PlatformPerformance[], onLinkedIn: boolean, row: LinkedInMetricsRow | undefined): PlatformPerformance[] {
  const label = PLATFORM_LABEL.linkedin;
  const rest = platforms.filter((p) => p.platform !== label);
  if (!onLinkedIn && !platforms.some((p) => p.platform === label)) return platforms;
  const live = platforms.find((p) => p.platform === label);
  const li: PlatformPerformance = row
    ? {
        platform: label,
        permalink: row.permalink ?? live?.permalink,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        saves: null,
        impressions: row.impressions,
        unique_views: row.unique_views,
      }
    : { platform: label, permalink: live?.permalink, likes: null, comments: null, shares: null, saves: null, note: LINKEDIN_NOT_SYNCED_NOTE };
  return [...rest, li];
}

/**
 * سبب غياب مقاييس هدف بالعربية. SocialAPI تُرجع 200 دائماً وتضع فشل كل منصة في targets[].error
 * (guides/analytics: «Read live post metrics»)، فلا يصح تجاهله وإلا ظهر التقرير فارغاً بلا تفسير.
 */
export function metricsErrorNote(t: PostTarget): string | undefined {
  const e = t.error;
  if (!e) return undefined;
  const code = e.code ?? '';
  if (code === 'resource.not_supported') return 'المنصة لا تتيح مقاييس المنشورات عبر SocialAPI';
  if (code === 'platform.twitter.usage_capped') return 'نفد رصيد تطبيق X أو بلغ حد الإنفاق؛ أضف رصيداً من X Developer Console';
  if (e.category === 'auth' || code === 'account.reconnection_required' || code.endsWith('.auth') || code.endsWith('.permission_denied')) {
    return 'يلزم إعادة ربط الحساب من لوحة SocialAPI';
  }
  if (code === 'resource.not_found') {
    return `${e.message || 'غير موجود'} (تحقّق أن للحساب صلاحية analytics.read في SocialAPI وأن المنشور لم يُحذف)`;
  }
  return describeTargetError(t);
}

/**
 * أهداف المنشور التي تُحتسب: المنشورة فقط. قبل 2026-11-14 كانت SocialAPI تُرجع status فارغاً ("")
 * في مسار المقاييس (changelog)، فيُقبل الفارغ والغائب كمنشور؛ الأهداف غير المنشورة لا تُرجعها أصلاً.
 */
export function performanceTargets(targets: PostTarget[]): PlatformPerformance[] {
  return targets
    .filter((t) => !t.status || t.status === 'published')
    .map((t) => ({ platform: platformName(t.platform), permalink: t.permalink, ...readEngagement(t.metrics), note: metricsErrorNote(t) }));
}

/** أسباب غياب الأرقام بلا تكرار، بصيغة «المنصة: السبب». */
export function metricsNotes(items: PostPerformance[]): string[] {
  const out = new Set<string>();
  for (const i of items) for (const p of i.platforms) if (p.note) out.add(`${p.platform}: ${p.note}`);
  return [...out];
}

export interface PostPerformance {
  draft_id: number;
  pillar: string | null;
  title: string;
  published_at: string;
  platforms: PlatformPerformance[];
  /** مجموع الأرقام المتاحة، أو null إن لم يتوفر أي رقم. */
  total: number | null;
  /** تعذّر جلب مقاييس هذا المنشور. */
  failed: boolean;
}

export function engagementTotal(platforms: Engagement[]): number | null {
  let total = 0;
  let any = false;
  for (const p of platforms) {
    for (const v of [p.likes, p.comments, p.shares, p.saves]) {
      if (v !== null) {
        total += v;
        any = true;
      }
    }
  }
  return any ? total : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * أهداف كل منشور: طلب مجمّع لكل 20 منشوراً (GET /posts/metrics). إن لم يتوفر المسار المجمّع (404/405)
 * يُرجع إلى طلب لكل منشور. النتيجة لكل معرّف: الأهداف، أو الخطأ.
 */
async function fetchTargets(ctx: Ctx, ids: string[]): Promise<Map<string, PostTarget[] | { error: unknown }>> {
  const out = new Map<string, PostTarget[] | { error: unknown }>();
  const perPost = async (chunk: string[]) => {
    await mapLimit(chunk, METRICS_CONCURRENCY, async (id) => {
      try {
        out.set(id, await getPostMetrics(ctx.env, id));
      } catch (error) {
        out.set(id, { error });
      }
    });
  };
  for (let i = 0; i < ids.length; i += BATCH_METRICS_MAX) {
    const chunk = ids.slice(i, i + BATCH_METRICS_MAX);
    try {
      const batch = await getPostsMetrics(ctx.env, chunk);
      for (const id of chunk) {
        const item = batch.get(id);
        if (!item) out.set(id, { error: new SocialApiError(200, 'resource.not_found', 'missing from batch response') });
        else if (item.error && !(item.targets ?? []).length) {
          out.set(id, { error: new SocialApiError(200, item.error.code ?? 'unknown', item.error.message ?? '') });
        } else out.set(id, item.targets ?? []);
      }
    } catch (err) {
      if (err instanceof SocialApiError && (err.status === 404 || err.status === 405)) await perPost(chunk);
      else for (const id of chunk) out.set(id, { error: err });
    }
  }
  return out;
}

/**
 * مقاييس منشورات آخر days يوماً، ثم أرقام لينكدن المحفوظة.
 * إن فشل الجلب لكل المنشورات يُرمى الخطأ الأول (مثل مفتاح غير صالح) بدل تقرير فارغ مضلل.
 */
export async function collectPerformance(ctx: Ctx, days = REPORT_WINDOW_DAYS): Promise<PostPerformance[]> {
  const published = await publishedSince(ctx.env.DB, days);
  let firstError: unknown = null;
  const fetched = await fetchTargets(ctx, [...new Set(published.map((p) => p.draft.socialapi_post_id ?? ''))].filter(Boolean));
  const items = published.map(({ draft, pillar }): PostPerformance => {
    const base = {
      draft_id: draft.id,
      pillar,
      title: draft.x_segments[0] ?? draft.linkedin_text,
      published_at: draft.published_at ?? draft.updated_at,
    };
    const r = fetched.get(draft.socialapi_post_id ?? '') ?? { error: new SocialApiError(0, 'unknown', 'no post id') };
    if (!Array.isArray(r)) {
      firstError ??= r.error;
      console.warn(JSON.stringify({ evt: 'metrics_failed', draft: draft.id, code: r.error instanceof SocialApiError ? r.error.code : 'unknown' }));
      return { ...base, platforms: [], total: null, failed: true };
    }
    for (const t of r) {
      if (t.error) console.warn(JSON.stringify({ evt: 'metrics_target_error', draft: draft.id, platform: t.platform, code: t.error.code ?? 'unknown' }));
    }
    const platforms = performanceTargets(r);
    return { ...base, platforms, total: engagementTotal(platforms), failed: false };
  });
  if (items.length > 0 && items.every((i) => i.failed)) throw firstError;

  const stored = await loadLinkedInMetrics(ctx.env.DB, published.map((p) => p.draft.id));
  return items.map((item, idx) => {
    const draft = published[idx]!.draft;
    if (item.failed && !stored.has(draft.id)) return item;
    const platforms = withLinkedIn(item.platforms, draft.platforms.includes('linkedin'), stored.get(draft.id));
    return { ...item, platforms, total: engagementTotal(platforms) };
  });
}

// ---------- لقطة المقاييس (تستفيد منها الخطة دون استدعاء المنصات من جديد) ----------

export interface SnapshotItem {
  draft_id: number;
  pillar: string | null;
  title: string;
  total: number | null;
}

export interface MetricsSnapshot {
  at: string;
  days: number;
  items: SnapshotItem[];
}

export async function saveSnapshot(db: D1Database, items: PostPerformance[], days = REPORT_WINDOW_DAYS): Promise<void> {
  const snapshot: MetricsSnapshot = {
    at: toSqlUtc(new Date()),
    days,
    items: items.map((i) => ({ draft_id: i.draft_id, pillar: i.pillar, title: truncate(i.title, 120), total: i.total })),
  };
  await setState(db, STATE_KEYS.metricsSnapshot, JSON.stringify(snapshot));
}

export function loadSnapshot(db: D1Database): Promise<MetricsSnapshot | null> {
  return getJsonState<MetricsSnapshot>(db, STATE_KEYS.metricsSnapshot);
}

export interface PillarStat {
  pillar: string;
  posts: number;
  measured: number;
  /** متوسط التفاعل للمنشورات ذات الأرقام، أو null إن لم يُقَس أي منشور. */
  avg: number | null;
}

export function pillarStats(items: Array<Pick<SnapshotItem, 'pillar' | 'total'>>): PillarStat[] {
  const groups = new Map<string, { posts: number; measured: number; sum: number }>();
  for (const i of items) {
    const key = i.pillar ?? 'غير مصنّف';
    const g = groups.get(key) ?? { posts: 0, measured: 0, sum: 0 };
    g.posts++;
    if (i.total !== null) {
      g.measured++;
      g.sum += i.total;
    }
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([pillar, g]) => ({ pillar, posts: g.posts, measured: g.measured, avg: g.measured ? Math.round(g.sum / g.measured) : null }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.posts - a.posts);
}

/** قسم أداء المحاور في تعليمات الخطة (SPEC §12: استخدام المقاييس في تحسين اقتراحات plan). */
export function performanceSection(snapshot: MetricsSnapshot | null): string | null {
  if (!snapshot || snapshot.items.length === 0) return null;
  const stats = pillarStats(snapshot.items);
  const measured = snapshot.items.filter((i) => i.total !== null);
  if (measured.length === 0) return null;
  const lines = stats.map(
    (s) => `- ${s.pillar}: ${postsAr(s.posts)}، ${s.avg === null ? 'بلا مقاييس متاحة' : `متوسط التفاعل ${s.avg}`}`,
  );
  const top = [...measured].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
  return [
    `أداء المحاور وفق آخر لقطة مقاييس (${formatRiyadhDate(parseUtc(snapshot.at))}، آخر ${snapshot.days} يوماً، التفاعل = إعجابات + تعليقات + مشاركات + حفظ):`,
    lines.join('\n'),
    top ? `أعلى منشور: «${top.title}» (تفاعل ${top.total}).` : '',
    measured.length < 3
      ? 'الأرقام قليلة، فلا تبنِ عليها ترجيحاً قوياً.'
      : 'رجّح المحاور والزوايا الأعلى تفاعلاً دون إهمال التوازن بين المحاور، ولا تستنتج ما لا تدعمه الأرقام.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- معدل التفاعل لكل ظهور، وملخص الشهر للمقارنة ----------

/** معدل التفاعل على لينكدن لكل ظهور (%)، بخانة عشرية واحدة؛ null بلا ظهور مسجّل. */
export function engagementRate(p: Pick<PlatformPerformance, 'likes' | 'comments' | 'shares' | 'impressions'>): number | null {
  const impressions = p.impressions ?? null;
  if (impressions === null || impressions <= 0) return null;
  const engaged = (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0);
  return Math.round((engaged / impressions) * 1000) / 10;
}

export interface MonthSummary {
  at: string;
  posts: number;
  measured: number;
  /** متوسط التفاعل للمنشور المقيس. */
  avg_engagement: number | null;
  /** متوسط معدل التفاعل لكل ظهور على لينكدن (%). */
  linkedin_rate: number | null;
  followers: number | null;
  pillars: Array<{ pillar: string; avg: number | null }>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const avgOf = (vals: number[]) => (vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null);

export function summarize(items: PostPerformance[], followers: number | null, at = new Date()): MonthSummary {
  const measured = items.filter((i) => i.total !== null);
  const rates = items.flatMap((i) => i.platforms.map(engagementRate).filter((r): r is number => r !== null));
  return {
    at: toSqlUtc(at),
    posts: items.length,
    measured: measured.length,
    avg_engagement: avgOf(measured.map((i) => i.total ?? 0)),
    linkedin_rate: avgOf(rates),
    followers,
    pillars: pillarStats(items).map((s) => ({ pillar: s.pillar, avg: s.avg })),
  };
}

const HISTORY_KEEP = 12;
/** ملخص يُعد «الشهر الماضي» إن مضى عليه 20 يوماً على الأقل. */
const PREVIOUS_MIN_AGE_DAYS = 20;

export async function loadHistory(db: D1Database): Promise<MonthSummary[]> {
  return (await getJsonState<MonthSummary[]>(db, STATE_KEYS.reportHistory)) ?? [];
}

export async function recordSummary(db: D1Database, summary: MonthSummary): Promise<void> {
  const history = [...(await loadHistory(db)), summary].slice(-HISTORY_KEEP);
  await setState(db, STATE_KEYS.reportHistory, JSON.stringify(history));
}

export function previousSummary(history: MonthSummary[], now = new Date()): MonthSummary | null {
  const old = history.filter((h) => (now.getTime() - parseUtc(h.at).getTime()) / 86_400_000 >= PREVIOUS_MIN_AGE_DAYS);
  return old.length ? old[old.length - 1]! : null;
}

function change(cur: number | null, prev: number | null, unit = ''): string | null {
  if (cur === null || prev === null) return null;
  const diff = round1(cur - prev);
  const pct = prev > 0 ? ` (${diff >= 0 ? '+' : ''}${Math.round((diff / prev) * 100)}%)` : '';
  return `${cur}${unit} مقابل ${prev}${unit}${pct}`;
}

/** سطر المقارنة بالشهر الماضي في التقرير، أو null إن لم يوجد ما يُقارن. */
export function comparisonLine(cur: MonthSummary, prev: MonthSummary | null): string | null {
  if (!prev) return null;
  const parts = [
    change(cur.avg_engagement, prev.avg_engagement) && `متوسط التفاعل للمنشور ${change(cur.avg_engagement, prev.avg_engagement)}`,
    change(cur.linkedin_rate, prev.linkedin_rate, '%') && `معدل التفاعل على لينكدن ${change(cur.linkedin_rate, prev.linkedin_rate, '%')}`,
    `عدد المنشورات ${cur.posts} مقابل ${prev.posts}`,
  ].filter(Boolean);
  return `📊 مقارنة بالشهر الماضي (${formatRiyadhDate(parseUtc(prev.at))}): ${parts.join('، ')}.`;
}

/** سطر المتابعين على لينكدن. */
export function followersLine(g: { current: number; delta: number | null; since: string | null } | null): string | null {
  if (!g) return null;
  const delta = g.delta === null || !g.since ? '' : ` (${g.delta >= 0 ? '+' : ''}${g.delta} منذ ${formatRiyadhDate(parseUtc(g.since))})`;
  return `👥 المتابعون على لينكدن: ${g.current}${delta}`;
}
