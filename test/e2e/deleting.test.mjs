// اختبارات طرفية للحذف النهائي: مسودة معلّقة أو مجدولة، وفكرة من /ideas، وأفكار البنك كلها، والمسودات المعلّقة كلها.

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

const LIVE = { vars: { DRY_RUN: 'false' } };
const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const inMinutes = (m) => new Date(Math.floor((Date.now() + m * 60_000) / 1000) * 1000);

async function idea(bot, status = 'new') {
  return (await bot.db.prepare("INSERT INTO ideas (text, pillar, status) VALUES ('فكرة', 'الحوكمة', ?) RETURNING id").bind(status).first()).id;
}

async function draft(bot, { status, ideaId = null, postId = null, at = null }) {
  const row = await bot.db
    .prepare(
      `INSERT INTO drafts (idea_id, x_segments, linkedin_text, snap_script, status, socialapi_post_id, scheduled_at, telegram_message_id)
       VALUES (?, ?, 'نص لينكدن', '[]', ?, ?, ?, 4242) RETURNING id`,
    )
    .bind(ideaId, JSON.stringify([`تغريدة ${status}`]), status, postId, at ? sql(at) : null)
    .first();
  return row.id;
}

const kbOf = (call) => call.body.reply_markup?.inline_keyboard.flat() ?? [];
const rowsOf = (call) => call.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data));
const dataOf = (call, prefix) => kbOf(call).find((b) => b.callback_data.startsWith(prefix))?.callback_data;
const sentStarting = (bot, prefix) => bot.tg('sendMessage').find((c) => c.body.text.startsWith(prefix));
const editedStarting = (bot, messageId, prefix) =>
  bot.tg('editMessageText').find((c) => c.body.message_id === messageId && c.body.text.startsWith(prefix));
const markups = (bot, messageId) => bot.tg('editMessageReplyMarkup').filter((c) => c.body.message_id === messageId);
const count = async (bot, table) => (await bot.row(`SELECT COUNT(*) AS n FROM ${table}`)).n;

// ---------- مسودة واحدة ----------

test('pending draft: «❌ احذف» asks in place, «تراجع» restores, confirming deletes it and returns its idea to the bank', () =>
  withBot({}, async (bot) => {
    const ideaId = await idea(bot, 'drafted');
    const id = await draft(bot, { status: 'pending', ideaId });

    await bot.press(`dd:${id}`, { messageId: 900 });
    const asking = await bot.waitFor(() => markups(bot, 900)[0], 5000, 'confirm buttons');
    assert.deepEqual(kbOf(asking).map((b) => b.text), [`✅ احذف المسودة #${id} نهائياً`, '↩️ تراجع']);
    await bot.waitFor(() => bot.answers().some((a) => /لا يمكن التراجع/.test(a.text ?? '')), 5000);
    assert.equal(await count(bot, 'drafts'), 1, 'nothing deleted before confirming');

    await bot.press(`bk:${id}`, { messageId: 900 });
    const back = await bot.waitFor(() => markups(bot, 900)[1], 5000, 'restored');
    assert.ok(kbOf(back).some((b) => b.text === '❌ احذف'));

    await bot.press(`dd:${id}`, { messageId: 900 });
    const again = await bot.waitFor(() => markups(bot, 900)[2], 5000);
    const confirm = dataOf(again, 'ddo:');
    await bot.press(confirm, { messageId: 900 });
    const done = await bot.waitFor(() => editedStarting(bot, 900, `🗑 حُذفت المسودة #${id} نهائياً.`), 5000, 'deleted');
    assert.match(done.body.text, new RegExp(`عادت الفكرة #${ideaId} إلى البنك`));
    assert.equal(await count(bot, 'drafts'), 0);
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = ?', ideaId)).status, 'new');
    assert.equal(bot.social('DELETE').length, 0, 'a pending draft has nothing in SocialAPI');

    // ضغطة ثانية على التأكيد لا تحذف شيئاً
    await bot.press(confirm, { messageId: 900 });
    await bot.waitFor(() => sentStarting(bot, 'لم أجد هذه المسودة'), 5000, 'second tap');
  }));

test('scheduled draft: cancels the post in SocialAPI first (GET → DELETE → GET 404), then deletes the draft', () =>
  withBot(LIVE, async (bot) => {
    const at = inMinutes(180);
    const id = await draft(bot, { status: 'scheduled', postId: 'p_77', at });
    bot.mocks.getPost = (pid) => ({ status: 200, json: { id: pid, status: 'scheduled', scheduled_at: iso(at), targets: [] } });

    await bot.press(`dd:${id}`, { messageId: 910 });
    const asking = await bot.waitFor(() => markups(bot, 910)[0], 5000);
    assert.equal(kbOf(asking)[0].text, `✅ ألغِ الجدولة واحذف #${id}`);
    assert.equal(bot.social('GET').length, 0, 'nothing reaches SocialAPI before confirming');

    await bot.press(dataOf(asking, 'ddo:'), { messageId: 910 });
    const done = await bot.waitFor(() => editedStarting(bot, 910, `🗑 حُذفت المسودة #${id} نهائياً.`), 10_000, 'deleted');
    assert.match(done.body.text, /وأُلغيت جدولتها في SocialAPI، فلن يُنشر شيء/);
    assert.deepEqual(
      bot.calls.filter((c) => c.host === 'api.social-api.ai').map((c) => `${c.method} ${c.path}`),
      ['GET /v1/posts/p_77', 'DELETE /v1/posts/p_77', 'GET /v1/posts/p_77'],
    );
    assert.equal(await count(bot, 'drafts'), 0);
  }));

test('deletion is refused near the scheduled time and for published drafts, with nothing sent to SocialAPI', () =>
  withBot(LIVE, async (bot) => {
    const soon = await draft(bot, { status: 'scheduled', postId: 'p_1', at: inMinutes(10) });
    const published = await draft(bot, { status: 'published', postId: 'p_2' });

    await bot.press(`dd:${soon}`, { messageId: 920 });
    await bot.waitFor(() => bot.answers().some((a) => a.show_alert && /15 دقيقة/.test(a.text ?? '')), 5000, 'too close');
    await bot.press(`dd:${published}`, { messageId: 921 });
    await bot.waitFor(() => bot.answers().some((a) => a.show_alert && a.text === 'لا تُحذف المسودة في حالتها الحالية.'), 5000);
    await bot.settle();
    assert.equal(markups(bot, 920).length + markups(bot, 921).length, 0);
    assert.equal(await count(bot, 'drafts'), 2);
    assert.equal(bot.calls.filter((c) => c.host === 'api.social-api.ai').length, 0);
  }));

// ---------- فكرة واحدة ----------

test('/ideas «❌ احذف»: asks in that row, «تراجع» restores, confirming deletes the idea and refreshes the list', () =>
  withBot({}, async (bot) => {
    await idea(bot);
    await idea(bot);
    await bot.sendText('/ideas');
    const list = await bot.waitFor(() => sentStarting(bot, '💡 أحدث الأفكار'), 5000);
    assert.deepEqual(rowsOf(list), [['fmt:2', 'arc:2', 'di:2'], ['fmt:1', 'arc:1', 'di:1'], ['dbk:2']]);

    await bot.press('di:2', { messageId: 321, markup: list.body.reply_markup });
    const asking = await bot.waitFor(() => markups(bot, 321)[0], 5000);
    assert.deepEqual(rowsOf(asking), [['dio:2', 'dix:2'], ['fmt:1', 'arc:1', 'di:1'], ['dbk:2']]);

    await bot.press('dix:2', { messageId: 321, markup: asking.body.reply_markup });
    const restored = await bot.waitFor(() => markups(bot, 321)[1], 5000);
    assert.deepEqual(rowsOf(restored), rowsOf(list));

    await bot.press('dio:2', { messageId: 321, markup: asking.body.reply_markup });
    const refreshed = await bot.waitFor(() => editedStarting(bot, 321, '💡 أحدث الأفكار'), 5000, 'refreshed list');
    assert.ok(!refreshed.body.text.includes('#2'));
    assert.deepEqual(rowsOf(refreshed), [['fmt:1', 'arc:1', 'di:1'], ['dbk:1']]);
    await bot.waitFor(() => bot.answers().some((a) => a.text === '🗑 حُذفت الفكرة #2'), 5000);
    assert.equal(await bot.row('SELECT id FROM ideas WHERE id = 2'), null);
  }));

test('an idea with a scheduled draft is not deleted; one with only unpublished drafts takes them with it', () =>
  withBot({}, async (bot) => {
    const guarded = await idea(bot);
    await draft(bot, { status: 'scheduled', ideaId: guarded, postId: 'p_9', at: inMinutes(600) });
    const plain = await idea(bot);
    await draft(bot, { status: 'pending', ideaId: plain });
    await draft(bot, { status: 'rejected', ideaId: plain });

    await bot.press(`dio:${guarded}`, { messageId: 330 });
    await bot.waitFor(() => bot.answers().some((a) => a.show_alert && /لها مسودة مجدولة أو منشورة/.test(a.text ?? '')), 5000);
    assert.ok(await bot.row('SELECT id FROM ideas WHERE id = ?', guarded));

    await bot.press(`dio:${plain}`, { messageId: 330 });
    await bot.waitFor(() => bot.answers().some((a) => a.text === `🗑 حُذفت الفكرة #${plain} ومعها مسودتان`), 5000);
    assert.equal(await count(bot, 'drafts'), 1, 'only the scheduled draft remains');
  }));

// ---------- الحذف الجماعي ----------

test('«احذف كل أفكار البنك»: confirmation names the count, deletes only bank ideas seen at the time; «إلغاء» deletes nothing', () =>
  withBot({}, async (bot) => {
    for (let i = 0; i < 3; i++) await idea(bot);
    await idea(bot, 'archived');
    await idea(bot, 'drafted');
    await bot.sendText('/ideas');
    const list = await bot.waitFor(() => sentStarting(bot, '💡 أحدث الأفكار'), 5000);
    const all = dataOf(list, 'dbk:');
    assert.equal(kbOf(list).at(-1).text, '🗑 احذف كل أفكار البنك (3)');

    await bot.press(all);
    const ask = await bot.waitFor(() => sentStarting(bot, 'حذف كل أفكار البنك نهائياً؟ (3 أفكار)'), 5000);
    await bot.press('dlx', { messageId: 340 });
    await bot.waitFor(() => editedStarting(bot, 340, 'أُلغي الحذف، ولم يُحذف شيء.'), 5000);
    assert.equal(await count(bot, 'ideas'), 5);

    const later = await idea(bot); // أُضيفت بعد عرض التأكيد
    await bot.press(dataOf(ask, 'dbo:'), { messageId: 341 });
    await bot.waitFor(() => editedStarting(bot, 341, '🗑 حُذفت 3 أفكار من البنك نهائياً.'), 5000);
    const left = await bot.db.prepare('SELECT id, status FROM ideas ORDER BY id').all();
    assert.deepEqual(
      left.results.map((r) => r.status),
      ['archived', 'drafted', 'new'],
    );
    assert.equal(left.results.at(-1).id, later);
  }));

test('«احذف كل المعلّقة» in /queue: deletes pending and failed drafts, keeps scheduled ones, returns ideas to the bank', () =>
  withBot({}, async (bot) => {
    for (const status of ['pending', 'pending', 'failed']) await draft(bot, { status, ideaId: await idea(bot, 'drafted') });
    const scheduled = await draft(bot, { status: 'scheduled', postId: 'p_3', at: inMinutes(600) });

    await bot.sendText('/queue');
    const queue = await bot.waitFor(() => sentStarting(bot, '📋 قائمة الانتظار'), 5000);
    assert.equal(kbOf(queue).at(-1).text, '🗑 احذف كل المعلّقة (3)');
    await bot.press(dataOf(queue, 'dpd:'));
    const ask = await bot.waitFor(() => sentStarting(bot, 'حذف كل المسودات المعلّقة نهائياً؟ (3 مسودات)'), 5000);
    assert.match(ask.body.text, /المجدولة لا تُحذف هنا/);

    await bot.press(dataOf(ask, 'dpo:'), { messageId: 350 });
    const done = await bot.waitFor(() => editedStarting(bot, 350, '🗑 حُذفت 3 مسودات معلّقة نهائياً.'), 5000);
    assert.match(done.body.text, /عادت 3 أفكار إلى البنك/);
    const left = await bot.db.prepare('SELECT id FROM drafts').all();
    assert.deepEqual(left.results.map((r) => r.id), [scheduled]);
    assert.equal((await bot.row("SELECT COUNT(*) AS n FROM ideas WHERE status = 'new'")).n, 3);
  }));
