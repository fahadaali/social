// اختبارات طرفية لعرض معرّفات حسابات SocialAPI عند /start (accounts.ts)، بديلاً عن سكربت الطرفية.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startBot } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

const HEADER = '🔗 معرّفات حساباتك في SocialAPI';

/** يرسل /start وينتظر الترحيب ثم هدوء الطلبات، ويعيد رسائل البوت التي تلت الترحيب. */
async function afterStart(bot) {
  const before = bot.tg('sendMessage').length;
  await bot.sendText('/start');
  await bot.waitFor(() => bot.tg('sendMessage').slice(before).some((c) => c.body.text.startsWith('أهلاً بك')), 10_000, 'welcome');
  await bot.settle();
  const sent = bot.tg('sendMessage').slice(before);
  const welcome = sent.findIndex((c) => c.body.text.startsWith('أهلاً بك'));
  return sent.slice(welcome + 1).map((c) => c.body);
}

const codeSpans = (msg) => (msg.entities ?? []).map((e) => [e.type, msg.text.slice(e.offset, e.offset + e.length)]);

test('with the account IDs missing, /start lists the connected accounts with copyable IDs', () =>
  withBot({ vars: { SOCIALAPI_X_ACCOUNT_ID: null, SOCIALAPI_LINKEDIN_ACCOUNT_ID: null } }, async (bot) => {
    const [hint, ...rest] = await afterStart(bot);
    assert.equal(rest.length, 0);
    assert.ok(hint.text.startsWith(HEADER), hint.text);
    assert.match(hint.text, /حساب X، المتغير SOCIALAPI_X_ACCOUNT_ID:\n• Owner @owner: acc_x\n/);
    assert.match(hint.text, /حساب لينكدن، المتغير SOCIALAPI_LINKEDIN_ACCOUNT_ID:\n• Owner Name: acc_li\n/, 'no handle when it equals the name');
    assert.match(hint.text, /ضع كل معرّف في متغيره في Cloudflare: الـ Worker ← Settings ← Variables and Secrets ← Add، بنوع Text، ثم Deploy\.$/);
    assert.deepEqual(codeSpans(hint), [
      ['code', 'SOCIALAPI_X_ACCOUNT_ID'],
      ['code', 'acc_x'],
      ['code', 'SOCIALAPI_LINKEDIN_ACCOUNT_ID'],
      ['code', 'acc_li'],
    ]);
    const [call] = bot.social('GET', '/v1/accounts');
    assert.equal(call.headers.authorization, 'Bearer sapi_key_test');
  }));

test('a configured ID that matches no account is flagged; company pages are not offered', () =>
  withBot({ vars: { SOCIALAPI_LINKEDIN_ACCOUNT_ID: 'acc_wrong' } }, async (bot) => {
    bot.mocks.accounts.json.data.push({ id: 'acc_page', platform: 'linkedin_page', name: 'Company', username: 'company', status: 'active' });
    const [hint] = await afterStart(bot);
    assert.match(hint.text, /حساب لينكدن، المتغير SOCIALAPI_LINKEDIN_ACCOUNT_ID:\n⚠️ القيمة المضبوطة لا تطابق أي حساب لينكدن مربوط\.\n• Owner Name: acc_li/);
    assert.ok(!hint.text.includes('acc_page'));
    assert.ok(!hint.text.includes('SOCIALAPI_X_ACCOUNT_ID'), 'X is set correctly');
    assert.ok(!hint.text.includes('acc_wrong'));
  }));

test('when everything matches, /start sends only the welcome', () =>
  withBot({}, async (bot) => {
    assert.deepEqual(await afterStart(bot), []);
    assert.equal(bot.social('GET', '/v1/accounts').length, 1);
  }));

test('a configured account that needs reconnecting is flagged without the list', () =>
  withBot({}, async (bot) => {
    Object.assign(bot.mocks.accounts.json.data[0], { status: 'reconnect_required', reconnect_reason: 'Token expired' });
    const [hint] = await afterStart(bot);
    assert.equal(hint.text, '⚠️ حساب X يحتاج إعادة ربط من لوحة SocialAPI: Token expired');
    assert.equal(hint.entities, undefined);
  }));

test('a platform with no connected account says to connect it first', () =>
  withBot({ vars: { SOCIALAPI_LINKEDIN_ACCOUNT_ID: null } }, async (bot) => {
    bot.mocks.accounts.json.data.splice(1, 1);
    const [hint] = await afterStart(bot);
    assert.match(hint.text, /حساب لينكدن، المتغير SOCIALAPI_LINKEDIN_ACCOUNT_ID:\nلا يوجد حساب لينكدن مربوط في SocialAPI بعد؛ اربطه من لوحتها أولاً\./);
  }));

test('a failed lookup is shown only when an ID is still needed', async () => {
  const forbidden = {
    status: 403,
    json: { error: { code: 'auth.insufficient_scope', message: 'missing scope', meta: { required_scope: 'accounts:read' } } },
  };
  await withBot({ vars: { SOCIALAPI_X_ACCOUNT_ID: null } }, async (bot) => {
    bot.mocks.accounts = forbidden;
    const [hint] = await afterStart(bot);
    assert.equal(hint.text, '⚠️ تعذّر جلب حساباتك من SocialAPI لعرض معرّفاتها: مفتاح SocialAPI لا يملك الصلاحية المطلوبة (accounts:read).');
  });
  await withBot({}, async (bot) => {
    bot.mocks.accounts = forbidden;
    assert.deepEqual(await afterStart(bot), [], 'IDs are set, so no noise');
  });
});

test('without SOCIALAPI_KEY there is no lookup', () =>
  withBot({ vars: { SOCIALAPI_KEY: null, SOCIALAPI_X_ACCOUNT_ID: null } }, async (bot) => {
    assert.deepEqual(await afterStart(bot), []);
    assert.equal(bot.social('GET', '/v1/accounts').length, 0);
  }));

test('a failure while sending the hint does not turn /start into an error', () =>
  withBot({ vars: { SOCIALAPI_X_ACCOUNT_ID: null } }, async (bot) => {
    bot.mocks.tgFail = (method, body) => method === 'sendMessage' && body.text.startsWith(HEADER);
    await afterStart(bot);
    assert.ok(bot.tg('sendMessage').some((c) => c.body.text.startsWith(HEADER)), 'the hint was attempted');
    assert.ok(!bot.texts().some((t) => t.startsWith('حدث خطأ')));
  }));
