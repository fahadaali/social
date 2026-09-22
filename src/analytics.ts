// مقاييس أداء المنشورات (SPEC §8 المقاييس، §10 report، §12 المرحلة 3).
// الرقم الذي لا تُرجعه المنصة يبقى «غير متوفر» (null) ولا يُحسب صفراً، حتى لا يُستنتج ما لا تدعمه الأرقام.

import type { Ctx } from './context.ts';
import { getJsonState, publishedSince, setState, STATE_KEYS } from './db.ts';
import { getPostMetrics, platformName, readEngagement, SocialApiError, type Engagement } from './socialapi.ts';
import { postsAr, truncate } from './text.ts';
import { formatRiyadhDate, parseUtc, toSqlUtc } from './time.ts';

export const REPORT_WINDOW_DAYS = 30;
const METRICS_CONCURRENCY = 4;

export interface PlatformPerformance extends Engagement {
  platform: string;
  permalink?: string | undefined;
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
 * مقاييس منشورات آخر days يوماً عبر GET /posts/{pid}/metrics.
 * إن فشل الجلب لكل المنشورات يُرمى الخطأ الأول (مثل مفتاح غير صالح) بدل تقرير فارغ مضلل.
 */
export async function collectPerformance(ctx: Ctx, days = REPORT_WINDOW_DAYS): Promise<PostPerformance[]> {
  const published = await publishedSince(ctx.env.DB, days);
  let firstError: unknown = null;
  const items = await mapLimit(published, METRICS_CONCURRENCY, async ({ draft, pillar }): Promise<PostPerformance> => {
    const base = {
      draft_id: draft.id,
      pillar,
      title: draft.x_segments[0] ?? draft.linkedin_text,
      published_at: draft.published_at ?? draft.updated_at,
    };
    try {
      const targets = await getPostMetrics(ctx.env, draft.socialapi_post_id ?? '');
      const platforms = targets
        .filter((t) => t.status === undefined || t.status === 'published')
        .map((t) => ({ platform: platformName(t.platform), permalink: t.permalink, ...readEngagement(t.metrics) }));
      return { ...base, platforms, total: engagementTotal(platforms), failed: false };
    } catch (err) {
      firstError ??= err;
      console.warn(JSON.stringify({ evt: 'metrics_failed', draft: draft.id, code: err instanceof SocialApiError ? err.code : 'unknown' }));
      return { ...base, platforms: [], total: null, failed: true };
    }
  });
  if (items.length > 0 && items.every((i) => i.failed)) throw firstError;
  return items;
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
