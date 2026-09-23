// أحداث الأيام الأخيرة من بحث الويب لاقتراحات النشر (طلب المالك، NOTES.md القسم 11):
// خطة الأحد تبني عليها اقتراحاً أو اثنين، ونشرة الأربعاء تُبنى عليها وحدها.

import { claudeErrorMessage, claudeSearch, ClaudeError } from './claude.ts';
import { PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import { getJsonState, setState, STATE_KEYS } from './db.ts';
import { draftModel } from './env.ts';
import {
  buildDigest,
  EVENTS_MAX_SEARCHES,
  EVENTS_MAX_TOKENS,
  eventsSystem,
  eventsUser,
  SEARCH_LOCATION,
  type EventDigest,
  type EventSource,
  type ResponseBlock,
} from './prompts/events.ts';
import { formatRiyadhDate } from './time.ts';

const DAY_MS = 86_400_000;
const RECENT_MAX = 15;
const RECENT_DAYS = 14;

interface RecentEvent extends EventSource {
  at: string;
}

/** أحداث اقتُرحت خلال الأسبوعين الأخيرين، الأحدث أولاً. */
async function recentEvents(db: D1Database, now: Date): Promise<RecentEvent[]> {
  const list = (await getJsonState<RecentEvent[]>(db, STATE_KEYS.recentEvents)) ?? [];
  return (Array.isArray(list) ? list : []).filter(
    (e) => e && typeof e.url === 'string' && now.getTime() - Date.parse(e.at) < RECENT_DAYS * DAY_MS,
  );
}

/**
 * يبحث عن أحداث آخر `days` أيام ويعيد ملخصها بمصادره، أو null إن لم يجد ما يستحق.
 * deadline أبكر من مهلة المهمة حتى يبقى وقت للخطة بعده.
 */
export async function researchEvents(ctx: Ctx, days: number, deadline: number): Promise<EventDigest | null> {
  const now = new Date();
  const avoid = (await recentEvents(ctx.env.DB, now)).map((e) => e.title);
  const blocks = await claudeSearch(ctx.env, {
    model: draftModel(ctx.env),
    system: eventsSystem(PILLARS_MD),
    user: eventsUser(formatRiyadhDate(now), formatRiyadhDate(new Date(now.getTime() - days * DAY_MS)), avoid),
    maxTokens: EVENTS_MAX_TOKENS,
    tool: { type: 'web_search_20250305', name: 'web_search', max_uses: EVENTS_MAX_SEARCHES, user_location: SEARCH_LOCATION },
    deadline,
    label: 'events',
  });
  return buildDigest(blocks as ResponseBlock[]);
}

/** يحفظ الأحداث التي اقتُرحت حتى لا يعيدها البحث التالي. */
export async function rememberEvents(db: D1Database, sources: EventSource[]): Promise<void> {
  if (!sources.length) return;
  const now = new Date();
  const at = now.toISOString();
  const fresh = sources.map((s) => ({ url: s.url, title: s.title, at }));
  const urls = new Set(fresh.map((e) => e.url));
  const kept = (await recentEvents(db, now)).filter((e) => !urls.has(e.url));
  await setState(db, STATE_KEYS.recentEvents, JSON.stringify([...fresh, ...kept].slice(0, RECENT_MAX)));
}

/** سبب فشل البحث للمالك، مع تلميح إن كان البحث في الويب معطّلاً في حساب Anthropic. */
export function eventsErrorMessage(err: unknown): string {
  if (err instanceof ClaudeError && err.kind === 'http' && err.status === 400 && /web.?search/i.test(err.message)) {
    return 'البحث في الويب غير مفعّل في حساب Anthropic. فعّله من Claude Console ← Settings ← Privacy.';
  }
  if (err instanceof ClaudeError && err.kind === 'timeout') return 'استغرق البحث وقتاً أطول من المسموح.';
  return claudeErrorMessage(err);
}
