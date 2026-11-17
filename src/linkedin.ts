// أرقام منشورات لينكدن (طلب المالك): مسار المقاييس الحية لا يدعم لينكدن، فتُسحب من LinkedIn Insights
// يومي 1 و16 من كل شهر (كل 15 يوماً تقريباً) وتُحفظ في جدول linkedin_metrics، ثم يقرؤها التقرير الشهري.
// المسار لا يغطي إلا آخر 5 منشورات للحساب الشخصي، فالسحب كل 15 يوماً يلتقط كل منشور قبل أن يخرج منها.

import type { Ctx } from './context.ts';
import { getState, publishedSince, setState, STATE_KEYS } from './db.ts';
import { accountId } from './env.ts';
import { getLinkedInInsights, getPost, type LinkedInPostInsight } from './socialapi.ts';
import { daysBetween, parseUtc, toSqlUtc } from './time.ts';

/** المدة التي يُعد بعدها آخر سحب قديماً، فيسحب التقرير قبل كتابته. */
export const LINKEDIN_SYNC_MAX_AGE_DAYS = 15;
/** المنشورات التي يُبحث عن مطابقها: أطول من نافذة التقرير قليلاً. */
const MATCH_WINDOW_DAYS = 45;

export interface LinkedInMetricsRow {
  linkedin_post_id: string;
  draft_id: number | null;
  permalink: string | null;
  impressions: number | null;
  unique_views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  synced_at: string;
}

/** مفاتيح المطابقة لمعرّف أو رابط لينكدن: النص كما هو، وURN المنشور إن ظهر فيه. */
export function linkedinKeys(...values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    out.add(v.trim());
    for (const m of v.matchAll(/urn(?::|%3A)li(?::|%3A)(share|ugcPost|activity)(?::|%3A)(\d+)/gi)) out.add(`urn:li:${m[1]}:${m[2]}`);
  }
  return [...out];
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LinkedInSyncResult {
  fetched: number;
  matched: number;
}

/**
 * يسحب أرقام آخر منشورات لينكدن ويحفظها، مطابقاً كل منشور بمسودته عبر معرّف SocialAPI أو معرّف لينكدن أو الرابط.
 * يرمي الخطأ إن فشل السحب (صلاحية ناقصة، حساب غير مربوط…) ليُبلَّغ المالك به.
 */
export async function syncLinkedIn(ctx: Ctx): Promise<LinkedInSyncResult> {
  const account = accountId(ctx.env, 'linkedin');
  if (!account) throw new Error('معرّف حساب لينكدن غير مضبوط (SOCIALAPI_LINKEDIN_ACCOUNT_ID).');
  const insights = await getLinkedInInsights(ctx.env, account);

  // مفاتيح مسودات لينكدن المنشورة مؤخراً → رقم المسودة
  const byKey = new Map<string, number>();
  const published = (await publishedSince(ctx.env.DB, MATCH_WINDOW_DAYS)).filter(({ draft }) => draft.platforms.includes('linkedin'));
  for (const { draft } of published) {
    const postId = draft.socialapi_post_id;
    if (!postId) continue;
    byKey.set(postId, draft.id);
    try {
      const post = await getPost(ctx.env, postId);
      const t = (post.targets ?? []).find((x) => x.platform === 'linkedin');
      for (const k of linkedinKeys(t?.platform_post_id, t?.permalink)) byKey.set(k, draft.id);
    } catch (err) {
      console.warn(JSON.stringify({ evt: 'linkedin_match_lookup_failed', draft: draft.id }));
    }
  }

  const now = toSqlUtc(new Date());
  let matched = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const p of insights.posts) {
    const id = p.post_id?.trim();
    if (!id) continue;
    const draftId = draftFor(p, byKey);
    if (draftId !== null) matched++;
    stmts.push(
      ctx.env.DB.prepare(
        `INSERT INTO linkedin_metrics (linkedin_post_id, draft_id, permalink, impressions, unique_views, likes, comments, shares, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(linkedin_post_id) DO UPDATE SET
           draft_id = COALESCE(excluded.draft_id, linkedin_metrics.draft_id), permalink = COALESCE(excluded.permalink, linkedin_metrics.permalink),
           impressions = excluded.impressions, unique_views = excluded.unique_views, likes = excluded.likes,
           comments = excluded.comments, shares = excluded.shares, synced_at = excluded.synced_at`,
      ).bind(id, draftId, p.permalink ?? null, n(p.impressions), n(p.unique_views), n(p.likes), n(p.comments), n(p.shares), now),
    );
  }
  if (typeof insights.follower_count === 'number' && Number.isFinite(insights.follower_count)) {
    stmts.push(
      ctx.env.DB.prepare('INSERT INTO linkedin_followers (at, follower_count) VALUES (?, ?) ON CONFLICT(at) DO UPDATE SET follower_count = excluded.follower_count').bind(
        now,
        insights.follower_count,
      ),
    );
  }
  if (stmts.length) await ctx.env.DB.batch(stmts);
  await setState(ctx.env.DB, STATE_KEYS.linkedinSyncedAt, now);
  console.log(JSON.stringify({ evt: 'linkedin_synced', fetched: insights.posts.length, matched }));
  return { fetched: insights.posts.length, matched };
}

function draftFor(p: LinkedInPostInsight, byKey: Map<string, number>): number | null {
  for (const k of linkedinKeys(p.post_id, p.permalink)) {
    const d = byKey.get(k);
    if (d !== undefined) return d;
  }
  return null;
}

/** هل مضى على آخر سحب ناجح 15 يوماً أو أكثر (أو لم يُسحب قط)؟ */
export async function linkedinSyncDue(db: D1Database): Promise<boolean> {
  const last = await getState(db, STATE_KEYS.linkedinSyncedAt);
  return !last || daysBetween(parseUtc(last), new Date()) >= LINKEDIN_SYNC_MAX_AGE_DAYS;
}

/** آخر أرقام محفوظة لكل مسودة. */
export async function loadLinkedInMetrics(db: D1Database, draftIds: number[]): Promise<Map<number, LinkedInMetricsRow>> {
  const out = new Map<number, LinkedInMetricsRow>();
  if (!draftIds.length) return out;
  const r = await db
    .prepare(`SELECT * FROM linkedin_metrics WHERE draft_id IN (${draftIds.map(() => '?').join(',')}) ORDER BY synced_at ASC`)
    .bind(...draftIds)
    .all<LinkedInMetricsRow>();
  for (const row of r.results) if (row.draft_id !== null) out.set(row.draft_id, row);
  return out;
}

export interface FollowerGrowth {
  current: number;
  /** الفرق عن أقدم قراءة ضمن الفترة، أو null إن لم توجد إلا قراءة واحدة. */
  delta: number | null;
  since: string | null;
}

/**
 * عدد المتابعين الآن ونموّه: يُقارن بآخر قراءة أقدم من 25 يوماً (قرابة شهر بسحبين في الشهر)،
 * وإلا بأقدم قراءة متاحة.
 */
export async function followerGrowth(db: D1Database): Promise<FollowerGrowth | null> {
  const latest = await db.prepare('SELECT at, follower_count FROM linkedin_followers ORDER BY at DESC LIMIT 1').first<{ at: string; follower_count: number }>();
  if (!latest) return null;
  const base =
    (await db
      .prepare("SELECT at, follower_count FROM linkedin_followers WHERE at <= datetime(?, '-25 days') ORDER BY at DESC LIMIT 1")
      .bind(latest.at)
      .first<{ at: string; follower_count: number }>()) ??
    (await db
      .prepare('SELECT at, follower_count FROM linkedin_followers WHERE at < ? ORDER BY at ASC LIMIT 1')
      .bind(latest.at)
      .first<{ at: string; follower_count: number }>());
  return { current: latest.follower_count, delta: base ? latest.follower_count - base.follower_count : null, since: base?.at ?? null };
}
