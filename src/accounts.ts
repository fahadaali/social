// عند /start: يعرض للمالك وحده حساباته المربوطة في SocialAPI ومعرّفاتها إن نقص معرّف أو لم يطابق حساباً،
// فيضبطها من لوحة Cloudflare دون طرفية (NOTES.md القسم 10). لا يرسل شيئاً إن كان كل شيء سليماً.

import { getJsonState, setState, STATE_KEYS } from './db.ts';
import { accountId, configuredAccountId, PLATFORM_LABEL, PLATFORMS, type Env, type Platform } from './env.ts';
import { listAccounts, socialApiErrorMessage, type Account } from './socialapi.ts';
import type { MessageEntity } from './telegram.ts';

const VARIABLE: Record<Platform, string> = { x: 'SOCIALAPI_X_ACCOUNT_ID', linkedin: 'SOCIALAPI_LINKEDIN_ACCOUNT_ID' };
const MAX_LISTED = 10;

/** منصة الحساب: twitter هو X، و linkedin هو الحساب الشخصي (صفحات الشركات linkedin_page ليست ضمن البوت). */
function platformOf(a: Account): Platform | null {
  if (a.platform === 'twitter' || a.platform === 'x') return 'x';
  if (a.platform === 'linkedin') return 'linkedin';
  return null;
}

const needsReconnect = (a: Account) => !!a.status && a.status !== 'active';

function label(a: Account): string {
  const handle = a.username && a.username !== a.name ? `@${a.username}` : '';
  return ([a.name, handle].filter(Boolean).join(' ') || a.platform).slice(0, 60);
}

export interface AccountHint {
  text: string;
  entities: MessageEntity[];
}

export async function accountSetupHint(env: Env): Promise<AccountHint | null> {
  if (!String(env.SOCIALAPI_KEY ?? '').trim()) return null;
  const missing = PLATFORMS.some((p) => !accountId(env, p));
  let accounts: Account[];
  try {
    accounts = await listAccounts(env);
  } catch (err) {
    // المعرّفات مضبوطة فلا حاجة للقائمة، ولا نزعج المالك (قد يكون المفتاح بلا accounts:read عمداً)
    if (!missing) {
      console.warn(JSON.stringify({ evt: 'accounts_check_failed', err: err instanceof Error ? err.message : 'unknown' }));
      return null;
    }
    return { text: `⚠️ تعذّر جلب حساباتك من SocialAPI لعرض معرّفاتها: ${socialApiErrorMessage(err)}`, entities: [] };
  }

  const platforms = PLATFORMS.map((p) => {
    const mine = accounts.filter((a) => eligible(a, p));
    const configured = accountId(env, p);
    return { p, mine, configured, match: configured ? mine.find((a) => a.id === configured) : undefined };
  });
  const toList = platforms.filter((x) => !x.match);
  const reconnect = platforms.filter((x) => x.match && needsReconnect(x.match));
  if (!toList.length && !reconnect.length) return null;

  let text = '';
  const entities: MessageEntity[] = [];
  // offset وlength بوحدات UTF-16، وهي أطوال النصوص في JavaScript
  const add = (s: string, asCode = false) => {
    if (asCode) entities.push({ type: 'code', offset: text.length, length: s.length });
    text += s;
  };

  for (const { p, match } of reconnect) {
    add(`⚠️ حساب ${PLATFORM_LABEL[p]} يحتاج إعادة ربط من لوحة SocialAPI${match?.reconnect_reason ? `: ${match.reconnect_reason}` : '.'}\n`);
  }
  if (toList.length) {
    if (text) add('\n');
    add('🔗 معرّفات حساباتك في SocialAPI (المس المعرّف لنسخه):\n');
    for (const { p, mine, configured } of toList) {
      add(`\nحساب ${PLATFORM_LABEL[p]}، المتغير `);
      add(VARIABLE[p], true);
      add(':\n');
      if (configured) add(`⚠️ القيمة المضبوطة لا تطابق أي حساب ${PLATFORM_LABEL[p]} مربوط.\n`);
      if (!mine.length) add(`لا يوجد حساب ${PLATFORM_LABEL[p]} مربوط في SocialAPI بعد؛ اربطه من لوحتها أولاً.\n`);
      for (const a of mine.slice(0, MAX_LISTED)) {
        add(`• ${label(a)}: `);
        add(a.id, true);
        add(needsReconnect(a) ? ' (يحتاج إعادة ربط)\n' : '\n');
      }
    }
    add('\nالبوت يختار الحساب تلقائياً متى كان حساباً واحداً لكل منصة. مع أكثر من حساب، ضع المعرّف المطلوب في متغيره في Cloudflare: الـ Worker ← Settings ← Variables and Secrets ← Add، بنوع Text، ثم Deploy.');
  }
  return { text: text.trimEnd(), entities };
}

// ---------- اكتشاف الحسابات تلقائياً (طلب المالك: لا حاجة لنسخ المعرّف إلى Cloudflare) ----------

/** حساب لينكدن الشخصي فقط: صفحات الشركات صارت linkedin أيضاً منذ 2026-11-04 لكن connection_type فيها organization. */
function eligible(a: Account, p: Platform): boolean {
  if (platformOf(a) !== p && !(p === 'linkedin' && a.platform === 'linkedin_page')) return false;
  if (p === 'linkedin') return a.platform === 'linkedin' && a.connection_type !== 'organization';
  return true;
}

/**
 * يختار حساب المنصة: المتغير إن طابق حساباً مربوطاً، وإلا الحساب الوحيد النشط (أو الوحيد إطلاقاً)،
 * وإلا (عدة حسابات بلا متغير مطابق) يبقى المتغير كما هو ليعرض /start الخيارات.
 */
export function resolveAccount(accounts: Account[], p: Platform, configured: string | null): string | null {
  const mine = accounts.filter((a) => eligible(a, p));
  if (configured && mine.some((a) => a.id === configured)) return configured;
  const active = mine.filter((a) => !needsReconnect(a));
  if (active.length === 1) return active[0]!.id;
  if (mine.length === 1) return mine[0]!.id;
  return configured;
}

interface ResolvedCache {
  at: number;
  /** المتغيران وقت الاكتشاف: تغيّرهما يُبطل الذاكرة. */
  configured: Partial<Record<Platform, string | null>>;
  ids: Partial<Record<Platform, string | null>>;
}

/** مدة صلاحية الاكتشاف: إعادة ربط حساب تُلتقط خلال ساعة، و/start يفرض إعادته فوراً. */
const RESOLVE_TTL_MS = 60 * 60 * 1000;

const apply = (env: Env, ids: ResolvedCache['ids']): Env => {
  const resolved: Partial<Record<Platform, string>> = {};
  for (const p of PLATFORMS) {
    const id = ids[p];
    if (id) resolved[p] = id;
  }
  return { ...env, resolvedAccounts: resolved };
};

/** البيئة بمعرّفات الحسابات المكتشفة. فشل SocialAPI لا يوقف شيئاً: تُستعمل آخر قيمة محفوظة أو المتغيرات. */
export async function withAccounts(env: Env, opts: { force?: boolean } = {}): Promise<Env> {
  if (!env.DB || !String(env.SOCIALAPI_KEY ?? '').trim()) return env;
  const configured = Object.fromEntries(PLATFORMS.map((p) => [p, configuredAccountId(env, p)])) as ResolvedCache['configured'];
  const cached = await getJsonState<ResolvedCache>(env.DB, STATE_KEYS.resolvedAccounts);
  const sameConfig = cached && PLATFORMS.every((p) => (cached.configured[p] ?? null) === (configured[p] ?? null));
  if (!opts.force && cached && sameConfig && Date.now() - cached.at < RESOLVE_TTL_MS) return apply(env, cached.ids);
  try {
    const accounts = await listAccounts(env);
    const ids = Object.fromEntries(PLATFORMS.map((p) => [p, resolveAccount(accounts, p, configured[p] ?? null)])) as ResolvedCache['ids'];
    await setState(env.DB, STATE_KEYS.resolvedAccounts, JSON.stringify({ at: Date.now(), configured, ids } satisfies ResolvedCache));
    if (cached && PLATFORMS.some((p) => cached.ids[p] !== ids[p])) console.log(JSON.stringify({ evt: 'accounts_resolved', changed: true }));
    return apply(env, ids);
  } catch (err) {
    console.warn(JSON.stringify({ evt: 'accounts_resolve_failed', err: err instanceof Error ? err.message : 'unknown' }));
    return cached ? apply(env, cached.ids) : env;
  }
}
