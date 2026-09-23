// الوصول إلى D1 (SPEC §5). كل الأوقات المخزنة بصيغة SQLite ('YYYY-MM-DD HH:MM:SS' بتوقيت UTC).

import { PLATFORMS, type Platform } from './env.ts';
import type { DraftContent } from './text.ts';

export type IdeaStatus = 'new' | 'drafted' | 'published' | 'archived';
export type IdeaSource = 'text' | 'voice' | 'photo' | 'plan';
export type DraftStatus = 'pending' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'rejected';

export interface Idea {
  id: number;
  text: string;
  pillar: string | null;
  source: string;
  status: IdeaStatus;
  created_at: string;
}

export interface Draft extends DraftContent {
  id: number;
  idea_id: number | null;
  media_id: string | null;
  platforms: Platform[];
  status: DraftStatus;
  socialapi_post_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  telegram_message_id: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: number;
  idea_id: number | null;
  x_segments: string;
  linkedin_text: string;
  snap_script: string | null;
  needs_visual: number;
  visual_brief: string | null;
  notes: string | null;
  media_id: string | null;
  platforms: string;
  status: DraftStatus;
  socialapi_post_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  telegram_message_id: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    idea_id: r.idea_id,
    x_segments: jsonArray(r.x_segments),
    linkedin_text: r.linkedin_text,
    snap_script: jsonArray(r.snap_script),
    needs_visual: r.needs_visual === 1,
    visual_brief: r.visual_brief,
    notes: r.notes,
    media_id: r.media_id,
    platforms: jsonArray(r.platforms).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p)),
    status: r.status,
    socialapi_post_id: r.socialapi_post_id,
    scheduled_at: r.scheduled_at,
    published_at: r.published_at,
    telegram_message_id: r.telegram_message_id,
    revision: r.revision,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ---------- منع التكرار (SPEC §4.3) ----------

/** يعيد true إذا كان التحديث جديداً، وfalse إذا عولج من قبل. */
export async function markUpdateProcessed(db: D1Database, updateId: number): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO processed_updates (update_id) VALUES (?) ON CONFLICT(update_id) DO NOTHING')
    .bind(updateId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function cleanupProcessedUpdates(db: D1Database): Promise<number> {
  const r = await db.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now', '-7 days')").run();
  return r.meta.changes ?? 0;
}

// ---------- الحالة ----------

// مفاتيح جدول state (SPEC §5) المستخدمة في أكثر من وحدة
export const STATE_KEYS = {
  lastPublishedAt: 'last_published_at',
  remindersPaused: 'reminders_paused',
  lastPlan: 'last_plan',
  metricsSnapshot: 'metrics_snapshot',
} as const;

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** يحدّث القيمة فقط إن كانت أحدث (صيغة وقت SQLite تُقارن نصياً بترتيب زمني صحيح). */
export async function setStateIfNewer(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE state.value IS NULL OR excluded.value > state.value`,
    )
    .bind(key, value)
    .run();
}

export async function deleteState(db: D1Database, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.batch(keys.map((k) => db.prepare('DELETE FROM state WHERE key = ?').bind(k)));
}

export async function getJsonState<T>(db: D1Database, key: string): Promise<T | null> {
  const v = await getState(db, key);
  if (v === null) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

// حالات الانتظار: awaiting_edit و awaiting_image (SPEC §5 و§7). واحدة فقط فعّالة في كل مرة.
export type AwaitingKind = 'edit' | 'image';
const AWAITING_KEYS: Record<AwaitingKind, string> = { edit: 'awaiting_edit', image: 'awaiting_image' };
const AWAITING_TTL_MS = 60 * 60 * 1000; // ساعة، حتى لا يُفسَّر نص لاحق بعد نسيان الطلب كملاحظات

export interface Awaiting {
  draft_id: number;
  at: number;
}

export async function setAwaiting(db: D1Database, kind: AwaitingKind, draftId: number): Promise<void> {
  const other: AwaitingKind = kind === 'edit' ? 'image' : 'edit';
  await db.batch([
    db.prepare('DELETE FROM state WHERE key = ?').bind(AWAITING_KEYS[other]),
    db
      .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(AWAITING_KEYS[kind], JSON.stringify({ draft_id: draftId, at: Date.now() } satisfies Awaiting)),
  ]);
}

export async function getAwaiting(db: D1Database, kind: AwaitingKind): Promise<Awaiting | null> {
  const a = await getJsonState<Awaiting>(db, AWAITING_KEYS[kind]);
  if (!a || typeof a.draft_id !== 'number') return null;
  if (Date.now() - a.at > AWAITING_TTL_MS) return null;
  return a;
}

export async function clearAwaiting(db: D1Database): Promise<void> {
  await deleteState(db, AWAITING_KEYS.edit, AWAITING_KEYS.image);
}

// ---------- الأفكار ----------

export async function insertIdea(db: D1Database, text: string, source: IdeaSource): Promise<Idea> {
  const idea = await db
    .prepare('INSERT INTO ideas (text, source) VALUES (?, ?) RETURNING *')
    .bind(text, source)
    .first<Idea>();
  if (!idea) throw new Error('insert idea returned nothing');
  return idea;
}

export function getIdea(db: D1Database, id: number): Promise<Idea | null> {
  return db.prepare('SELECT * FROM ideas WHERE id = ?').bind(id).first<Idea>();
}

export async function setIdeaPillar(db: D1Database, id: number, pillar: string): Promise<void> {
  await db.prepare('UPDATE ideas SET pillar = ? WHERE id = ?').bind(pillar, id).run();
}

export async function setIdeaStatus(db: D1Database, id: number, status: IdeaStatus): Promise<void> {
  await db.prepare('UPDATE ideas SET status = ? WHERE id = ?').bind(status, id).run();
}

/** ينقل الفكرة من حالة إلى أخرى فقط إن كانت ما تزال في الحالة المتوقعة. */
export async function transitionIdea(db: D1Database, id: number, from: IdeaStatus, to: IdeaStatus): Promise<boolean> {
  const r = await db.prepare('UPDATE ideas SET status = ? WHERE id = ? AND status = ?').bind(to, id, from).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listNewIdeas(db: D1Database, limit: number, oldestFirst = false): Promise<Idea[]> {
  const order = oldestFirst ? 'ASC' : 'DESC';
  const r = await db
    .prepare(`SELECT * FROM ideas WHERE status = 'new' ORDER BY id ${order} LIMIT ?`)
    .bind(limit)
    .all<Idea>();
  return r.results;
}

// ---------- المسودات ----------

export async function insertDraft(
  db: D1Database,
  ideaId: number | null,
  content: DraftContent,
  platforms: Platform[],
): Promise<Draft> {
  const row = await db
    .prepare(
      `INSERT INTO drafts (idea_id, x_segments, linkedin_text, snap_script, needs_visual, visual_brief, notes, platforms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      ideaId,
      JSON.stringify(content.x_segments),
      content.linkedin_text,
      JSON.stringify(content.snap_script),
      content.needs_visual ? 1 : 0,
      content.visual_brief,
      content.notes,
      JSON.stringify(platforms),
    )
    .first<DraftRow>();
  if (!row) throw new Error('insert draft returned nothing');
  return rowToDraft(row);
}

export async function getDraft(db: D1Database, id: number): Promise<Draft | null> {
  const row = await db.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>();
  return row ? rowToDraft(row) : null;
}

/** يستبدل المحتوى ويرفع revision، بشرط أن تكون المسودة ما تزال قابلة للتعديل. */
export async function replaceDraftContent(db: D1Database, id: number, content: DraftContent): Promise<Draft | null> {
  const row = await db
    .prepare(
      `UPDATE drafts SET x_segments = ?, linkedin_text = ?, snap_script = ?, needs_visual = ?, visual_brief = ?,
         notes = ?, revision = revision + 1, updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'failed') RETURNING *`,
    )
    .bind(
      JSON.stringify(content.x_segments),
      content.linkedin_text,
      JSON.stringify(content.snap_script),
      content.needs_visual ? 1 : 0,
      content.visual_brief,
      content.notes,
      id,
    )
    .first<DraftRow>();
  return row ? rowToDraft(row) : null;
}

type DraftPatch = Partial<{
  media_id: string | null;
  platforms: Platform[];
  status: DraftStatus;
  socialapi_post_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  telegram_message_id: number | null;
}>;

export async function updateDraft(db: D1Database, id: number, patch: DraftPatch): Promise<void> {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cols.push(`${key} = ?`);
    values.push(key === 'platforms' ? JSON.stringify(value) : value);
  }
  if (cols.length === 0) return;
  await db
    .prepare(`UPDATE drafts SET ${cols.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...values, id)
    .run();
}

/**
 * انتقال حالة ذرّي: ينجح لطلب واحد فقط حتى لو ضُغط الزر مرتين،
 * فلا يُنشأ منشوران ولا يُستهلك رصيدان.
 */
export async function claimDraft(
  db: D1Database,
  id: number,
  from: DraftStatus[],
  to: DraftStatus,
  revision?: number,
): Promise<boolean> {
  const placeholders = from.map(() => '?').join(', ');
  const revClause = revision === undefined ? '' : ' AND revision = ?';
  const r = await db
    .prepare(
      `UPDATE drafts SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN (${placeholders})${revClause}`,
    )
    .bind(to, id, ...from, ...(revision === undefined ? [] : [revision]))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** موعد جديد لمسودة مجدولة، بشرط أنها ما تزال مجدولة على المنشور نفسه. */
export async function setScheduledAt(db: D1Database, id: number, postId: string, scheduledAt: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE drafts SET scheduled_at = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'scheduled' AND socialapi_post_id = ?`,
    )
    .bind(scheduledAt, id, postId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** بعد إلغاء الجدولة: تعود المسودة معلّقة بلا منشور، بشرط أنها ما تزال مجدولة على المنشور نفسه. */
export async function unscheduleDraft(db: D1Database, id: number, postId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE drafts SET status = 'pending', socialapi_post_id = NULL, scheduled_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND status = 'scheduled' AND socialapi_post_id = ?`,
    )
    .bind(id, postId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listDraftsByStatus(
  db: D1Database,
  statuses: DraftStatus[],
  limit = 50,
  newestFirst = false,
): Promise<Draft[]> {
  const placeholders = statuses.map(() => '?').join(', ');
  const r = await db
    .prepare(`SELECT * FROM drafts WHERE status IN (${placeholders}) ORDER BY id ${newestFirst ? 'DESC' : 'ASC'} LIMIT ?`)
    .bind(...statuses, limit)
    .all<DraftRow>();
  return r.results.map(rowToDraft);
}

export interface PublishedDraft {
  draft: Draft;
  pillar: string | null;
}

/** المنشورات المنشورة (كلياً أو جزئياً) خلال آخر days يوماً، الأحدث أولاً، مع محور فكرتها. */
export async function publishedSince(db: D1Database, days: number, limit = 50): Promise<PublishedDraft[]> {
  const r = await db
    .prepare(
      `SELECT d.*, i.pillar AS idea_pillar FROM drafts d LEFT JOIN ideas i ON i.id = d.idea_id
       WHERE d.status IN ('published', 'partial') AND d.socialapi_post_id IS NOT NULL
         AND d.published_at >= datetime('now', ?)
       ORDER BY d.published_at DESC LIMIT ?`,
    )
    .bind(`-${days} days`, limit)
    .all<DraftRow & { idea_pillar: string | null }>();
  return r.results.map((row) => ({ draft: rowToDraft(row), pillar: row.idea_pillar }));
}

/** آخر المنشورات المنشورة (لتجنب التكرار في الصياغة ولعناوين الخطة). */
export async function recentPublished(db: D1Database, limit: number): Promise<Draft[]> {
  const r = await db
    .prepare(
      `SELECT * FROM drafts WHERE status IN ('published', 'partial')
       ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ?`,
    )
    .bind(limit)
    .all<DraftRow>();
  return r.results.map(rowToDraft);
}

export async function countUpcomingScheduled(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'scheduled' AND scheduled_at > datetime('now')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------- النسخة الاحتياطية ----------

export async function allIdeas(db: D1Database): Promise<Idea[]> {
  return (await db.prepare('SELECT * FROM ideas ORDER BY id').all<Idea>()).results;
}

export async function allDrafts(db: D1Database): Promise<Draft[]> {
  return (await db.prepare('SELECT * FROM drafts ORDER BY id').all<DraftRow>()).results.map(rowToDraft);
}
