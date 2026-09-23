// عند /start: يعرض للمالك وحده حساباته المربوطة في SocialAPI ومعرّفاتها إن نقص معرّف أو لم يطابق حساباً،
// فيضبطها من لوحة Cloudflare دون طرفية (NOTES.md القسم 10). لا يرسل شيئاً إن كان كل شيء سليماً.

import { accountId, PLATFORM_LABEL, PLATFORMS, type Env, type Platform } from './env.ts';
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
    const mine = accounts.filter((a) => platformOf(a) === p);
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
    add('\nضع كل معرّف في متغيره في Cloudflare: الـ Worker ← Settings ← Variables and Secrets ← Add، بنوع Text، ثم Deploy.');
  }
  return { text: text.trimEnd(), entities };
}
