// اختبارات طرفية للإعداد من لوحة Cloudflare (NOTES.md القسم 10): الـ Worker ينشئ جداوله بنفسه،
// وصفحة /setup تفحص الإعداد وتربط تيليجرام بسر مشتق من توكن البوت.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { BOT_TOKEN, OWNER, SECRET, startBot } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

const ALL = ['0001_init.sql', '0002_draft_notes.sql'];
const DERIVED = createHmac('sha256', BOT_TOKEN).update('social-bot:telegram-webhook-secret').digest('base64url');

const applied = async (bot) =>
  (await bot.db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((r) => r.name);
const columns = async (bot, table) =>
  (await bot.db.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
/** نص الصفحة بلا وسوم HTML. */
const plain = (html) => html.replace(/<[^>]+>/g, '');
const setupText = async (bot) => plain((await bot.get('/setup')).text);

const replyTo = async (bot, text, prefix) => {
  const before = bot.tg('sendMessage').length;
  await bot.sendText(text);
  return bot.waitFor(
    () => bot.tg('sendMessage').slice(before).find((c) => c.body.text.startsWith(prefix)),
    10_000,
    `reply to ${text}`,
  );
};

const startUpdate = (updateId) => ({
  update_id: updateId,
  message: { message_id: updateId, date: 1, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, text: '/start' },
});

test('a fresh database gets its tables from the first update, recorded like wrangler', () =>
  withBot({ migrate: false }, async (bot) => {
    assert.equal((await bot.row("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ideas'")).n, 0);
    await replyTo(bot, '/start', 'أهلاً بك');
    assert.deepEqual(await applied(bot), ALL);
    assert.ok((await columns(bot, 'drafts')).includes('notes'), '0002 applied after 0001');
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM processed_updates')).n, 1);

    await replyTo(bot, 'فكرة: الحوكمة تبدأ بمصفوفة صلاحيات', 'حُفظت الفكرة');
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 1);
    assert.deepEqual(await applied(bot), ALL, 'nothing applied twice');
  }));

test('only the missing migrations are applied, and existing rows stay', () =>
  withBot({ migrate: ['0001_init.sql'] }, async (bot) => {
    await bot.db.prepare("INSERT INTO ideas (text) VALUES ('فكرة قديمة')").run();
    assert.ok(!(await columns(bot, 'drafts')).includes('notes'));
    await replyTo(bot, '/start', 'أهلاً بك');
    assert.deepEqual(await applied(bot), ALL);
    assert.ok((await columns(bot, 'drafts')).includes('notes'));
    assert.equal((await bot.row('SELECT text FROM ideas')).text, 'فكرة قديمة');
  }));

test('a database migrated by wrangler is left as it is', () =>
  withBot({}, async (bot) => {
    await replyTo(bot, '/start', 'أهلاً بك');
    assert.deepEqual(await applied(bot), ALL);
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM d1_migrations')).n, 2);
  }));

test('two updates at once on a fresh database both work', () =>
  withBot({ migrate: false }, async (bot) => {
    await Promise.all([bot.sendText('/start'), bot.sendText('/help')]);
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('أهلاً بك')), 10_000, 'welcome');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('طريقة العمل')), 10_000, 'help');
    assert.deepEqual(await applied(bot), ALL);
    assert.ok(!bot.texts().some((t) => t.startsWith('حدث خطأ')));
  }));

test('the scheduled tasks prepare the schema too', () =>
  withBot({ migrate: false }, async (bot) => {
    const result = await bot.scheduled('0 6 * * *');
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(await applied(bot), ALL);
  }));

test('/setup lists what is missing by name only and links Telegram with a derived secret', () =>
  withBot(
    { migrate: false, vars: { TELEGRAM_WEBHOOK_SECRET: null, SOCIALAPI_KEY: null, SOCIALAPI_LINKEDIN_ACCOUNT_ID: null, DRY_RUN: null } },
    async (bot) => {
      const page = await bot.get('/setup');
      assert.equal(page.status, 200);
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(page.headers['cache-control'], 'no-store');
      assert.match(page.text, /<html lang="ar" dir="rtl">/);

      const text = plain(page.text);
      assert.match(text, /✅ قاعدة البيانات وجداولها جاهزة/);
      assert.deepEqual(await applied(bot), ALL, '/setup prepares the tables');
      assert.match(text, /✅ TELEGRAM_BOT_TOKEN/);
      assert.match(text, /✅ ANTHROPIC_API_KEY/);
      assert.match(text, /❌ SOCIALAPI_KEY غير مضبوط: أضفه بنوع Secret/);
      assert.match(text, /✅ ALLOWED_TELEGRAM_USER_ID/);
      assert.match(text, /✅ SOCIALAPI_X_ACCOUNT_ID/);
      assert.match(text, /❌ SOCIALAPI_LINKEDIN_ACCOUNT_ID غير مضبوط: أضفه بنوع Text، وتجد قيمته بإرسال \/start للبوت/);
      assert.match(text, /❌ SOCIALAPI_KEY غير مضبوط: أضفه بنوع Secret\n/, 'the hint is for account IDs only');
      assert.match(text, /✅ تيليجرام مربوط بالعنوان https:\/\/bot\.example\/webhook/);
      assert.match(text, /🧪 وضع التجربة مفعّل/, 'no DRY_RUN means test mode');
      assert.match(text, /أكمل ما عليه ❌ من لوحة Cloudflare/);
      for (const value of [BOT_TOKEN, 'sk-ant-test', DERIVED, 'acc_x', String(OWNER)]) {
        assert.ok(!page.text.includes(value), `the page must not show ${value}`);
      }

      const hooks = bot.tg('setWebhook');
      assert.equal(hooks.length, 1);
      assert.deepEqual(hooks[0].body, {
        url: 'https://bot.example/webhook',
        secret_token: DERIVED,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      });
      assert.match(DERIVED, /^[A-Za-z0-9_-]{43}$/, 'characters Telegram accepts');

      // تيليجرام يرسل السر المشتق فيُقبل، والسر القديم يُرفض
      assert.equal((await bot.post(startUpdate(bot.nextUpdateId()))).status, 401);
      const before = bot.tg('sendMessage').length;
      const res = await bot.post(startUpdate(bot.nextUpdateId()), { 'X-Telegram-Bot-Api-Secret-Token': DERIVED });
      assert.equal(res.status, 200);
      await bot.waitFor(() => bot.tg('sendMessage').slice(before).find((c) => c.body.text.startsWith('أهلاً بك')), 10_000, 'welcome');
      assert.equal(bot.tg('sendMessage').length - before, 1, 'only the accepted update got a reply');
    },
  ));

test('/setup with everything set: the explicit secret wins and live mode shows', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    const page = await bot.get('/setup');
    const text = plain(page.text);
    assert.doesNotMatch(text, /❌/);
    assert.match(text, /🚀 النشر الفعلي مفعّل/);
    assert.match(text, /كل شيء جاهز\. التالي: أرسل \/start للبوت في تيليجرام\./);
    assert.equal(bot.lastTg('setWebhook').body.secret_token, SECRET);
    assert.ok(!page.text.includes(SECRET));

    // فتح الصفحة مرة أخرى يعيد الربط نفسه بلا ضرر
    await bot.get('/setup');
    assert.equal(bot.tg('setWebhook').length, 2);
    assert.deepEqual(bot.tg('setWebhook')[1].body, bot.tg('setWebhook')[0].body);
  }));

test('/setup without a bot token calls nothing, and the webhook rejects every request', () =>
  withBot({ vars: { TELEGRAM_BOT_TOKEN: null, TELEGRAM_WEBHOOK_SECRET: null, ALLOWED_TELEGRAM_USER_ID: 'abc' } }, async (bot) => {
    const text = await setupText(bot);
    assert.match(text, /❌ TELEGRAM_BOT_TOKEN غير مضبوط: أضفه بنوع Secret/);
    assert.match(text, /❌ ALLOWED_TELEGRAM_USER_ID يجب أن يكون أرقاماً فقط/);
    assert.match(text, /❌ لم يُربط تيليجرام بعد: يلزم TELEGRAM_BOT_TOKEN/);
    assert.equal(bot.calls.filter((c) => c.host === 'api.telegram.org').length, 0);
    for (const header of [SECRET, DERIVED, '']) {
      const res = await bot.post(startUpdate(bot.nextUpdateId()), { 'X-Telegram-Bot-Api-Secret-Token': header });
      assert.equal(res.status, 401);
    }
  }));

test('/setup explains Telegram failures, escaped, without exposing the token', () =>
  withBot({}, async (bot) => {
    bot.mocks.tgFail = (method) => method === 'setWebhook' && { status: 401, description: 'Unauthorized' };
    assert.match(await setupText(bot), /❌ تعذّر ربط تيليجرام: تيليجرام لم يقبل التوكن؛ راجع قيمة TELEGRAM_BOT_TOKEN/);

    bot.mocks.tgFail = (method) => method === 'setWebhook' && { status: 400, description: 'Bad Request: bad webhook: <HTTPS> required' };
    const page = await bot.get('/setup');
    assert.ok(page.text.includes('❌ تعذّر ربط تيليجرام: Bad Request: bad webhook: &#60;HTTPS&#62; required'));
    assert.ok(!page.text.includes('<HTTPS>'));
    assert.match(plain(page.text), /أكمل ما عليه ❌/);
    assert.ok(!page.text.includes(BOT_TOKEN));
  }));

test('without a D1 binding, /setup says how to link it and the bot tells the owner', () =>
  withBot({ withDb: false }, async (bot) => {
    const text = await setupText(bot);
    assert.match(text, /❌ قاعدة البيانات غير مربوطة: أضف من إعدادات الـ Worker ربط D1 باسم DB/);
    assert.match(text, /✅ تيليجرام مربوط/, 'still linked so the owner hears from the bot');
    await replyTo(bot, '/start', '⚠️ قاعدة البيانات غير مربوطة بالـ Worker بعد');
  }));

test('/setup answers GET only', () =>
  withBot({}, async (bot) => {
    assert.equal((await bot.get('/setup', 'POST')).status, 404);
    assert.equal(bot.tg('setWebhook').length, 0);
  }));
