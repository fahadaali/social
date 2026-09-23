// اختبارات طرفية للإضافات الوظيفية: تغيير موعد المجدول وإلغاؤه (بالضوابط)، وإعادة محاولة المنشور الجزئي،
// والتذكير بالمسودات الجاهزة، وأرشفة الأفكار، ونسخ سكربت سناب، والنسخة الاحتياطية /export.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER, startBot } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

const LIVE = { vars: { DRY_RUN: 'false' } };
const SNAP = ['إطار أول\nسطر ثانٍ', 'إطار ثانٍ', 'إطار ثالث'];

const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const inMinutes = (m) => new Date(Math.floor((Date.now() + m * 60_000) / 1000) * 1000);

/** موعد بتوقيت الرياض بعد dayOffset يوماً عند الساعة hour (كخيارات الجدولة). */
function riyadhSlot(dayOffset, hour) {
  const r = new Date(Date.now() + 3 * 3_600_000);
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate() + dayOffset, hour - 3));
}

async function seed(bot, { status, postId = null, at = null, snap = SNAP, idea = true } = {}) {
  let ideaId = null;
  if (idea) {
    ideaId = (await bot.db.prepare("INSERT INTO ideas (text, pillar, status) VALUES ('فكرة', 'الحوكمة', 'drafted') RETURNING id").first()).id;
  }
  const row = await bot.db
    .prepare(
      `INSERT INTO drafts (idea_id, x_segments, linkedin_text, snap_script, status, socialapi_post_id, scheduled_at, telegram_message_id)
       VALUES (?, ?, 'نص لينكدن', ?, ?, ?, ?, 4242) RETURNING id`,
    )
    .bind(ideaId, JSON.stringify(['تغريدة أولى', 'ثانية']), JSON.stringify(snap), status, postId, at ? sql(at) : null)
    .first();
  return row.id;
}

const PENDING_TARGETS = [
  { platform: 'twitter', status: 'pending' },
  { platform: 'linkedin', status: 'pending' },
];
const scheduledPost = (id, at, targets = PENDING_TARGETS) => ({
  status: 200,
  json: { id, status: 'scheduled', scheduled_at: iso(at), targets },
});
const partialPost = (id) => ({
  id,
  status: 'partial',
  targets: [
    { platform: 'twitter', status: 'published', permalink: 'https://x.com/owner/status/1' },
    { platform: 'linkedin', status: 'failed', error: { category: 'platform', code: 'platform.linkedin.timeout', message: 'LinkedIn timed out' } },
  ],
});
const publishedPost = (id) => ({
  id,
  status: 'published',
  published_at: new Date().toISOString(),
  targets: [
    { platform: 'twitter', status: 'published', permalink: 'https://x.com/owner/status/1' },
    { platform: 'linkedin', status: 'published', permalink: 'https://www.linkedin.com/feed/update/urn:li:share:9' },
  ],
});

const kbOf = (call) => call.body.reply_markup?.inline_keyboard.flat() ?? [];
const labels = (call) => kbOf(call).map((b) => b.text);
const dataOf = (call, prefix) => kbOf(call).find((b) => b.callback_data.startsWith(prefix))?.callback_data;
const socialCalls = (bot) => bot.calls.filter((c) => c.host === 'api.social-api.ai').map((c) => `${c.method} ${c.path}`);
const sentStarting = (bot, prefix) => bot.tg('sendMessage').find((c) => c.body.text.startsWith(prefix));
const editedStarting = (bot, messageId, prefix) =>
  bot.tg('editMessageText').find((c) => c.body.message_id === messageId && c.body.text.startsWith(prefix));

// ---------- تغيير الموعد ----------

test('scheduled: «عرض» shows change/cancel; «غيّر الموعد» hides the current slot; «تأكيد» → PATCH, D1 and buttons follow', () =>
  withBot(LIVE, async (bot) => {
    const current = riyadhSlot(1, 20); // غداً 8م
    const id = await seed(bot, { status: 'scheduled', postId: 'p_77', at: current });

    await bot.press(`shw:${id}`);
    const preview = await bot.waitFor(() => sentStarting(bot, `📝 مسودة #${id}`), 10_000, 'preview');
    assert.match(preview.body.text, /🕒 مجدولة: /);
    assert.deepEqual(labels(preview), ['🕒 غيّر الموعد', '🚫 ألغِ الجدولة', '📋 سكربت سناب']);

    await bot.press(`rsc:${id}`, { messageId: 500 });
    const options = await bot.waitFor(() => bot.tg('editMessageReplyMarkup').find((c) => c.body.message_id === 500), 5000, 'options');
    const picks = kbOf(options).filter((b) => b.callback_data.startsWith('rsa:'));
    const currentUnix = current.getTime() / 1000;
    assert.ok(picks.length >= 2);
    assert.ok(picks.every((b) => Number(b.callback_data.split(':')[2]) !== currentUnix), 'the current slot is not offered');
    assert.ok(!picks.some((b) => b.text === 'غداً 8م'));
    assert.equal(kbOf(options).at(-1).callback_data, `bk:${id}`);

    const pick = picks.find((b) => b.text === 'بعد غد 8ص');
    const newAt = new Date(Number(pick.callback_data.split(':')[2]) * 1000);
    await bot.press(pick.callback_data, { messageId: 500 });
    const confirm = await bot.waitFor(() => sentStarting(bot, `تأكيد تغيير موعد المسودة #${id}؟`), 5000, 'confirm');
    assert.match(confirm.body.text, /\nمن: .+، 8:00 م\nإلى: .+، 8:00 ص \(بتوقيت الرياض\)\nتغيير الموعد لا يستهلك رصيداً\.$/);
    assert.deepEqual(socialCalls(bot), [], 'nothing reaches SocialAPI before «تأكيد»');

    await bot.press(dataOf(confirm, 'rso:'), { messageId: 600 });
    const done = await bot.waitFor(() => editedStarting(bot, 600, `🕒 تغيّر موعد المسودة #${id} إلى`), 10_000, 'done');
    const patch = bot.social('PATCH');
    assert.equal(patch.length, 1);
    assert.equal(patch[0].path, '/v1/posts/p_77');
    assert.deepEqual(patch[0].body, { scheduled_at: iso(newAt) });
    const row = await bot.waitForRow(
      'SELECT status, scheduled_at, telegram_message_id FROM drafts WHERE id = ?',
      [id],
      (r) => r.telegram_message_id === 600,
      'buttons moved to the result message',
    );
    assert.deepEqual({ ...row }, { status: 'scheduled', scheduled_at: sql(newAt), telegram_message_id: 600 });
    assert.deepEqual(labels(done), ['🕒 غيّر الموعد', '🚫 ألغِ الجدولة', '📋 سكربت سناب']);
  }));

test('change and cancel are refused within 15 minutes of the scheduled time, before any SocialAPI call', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'scheduled', postId: 'p_77', at: inMinutes(10) });
    await bot.press(`rsc:${id}`);
    await bot.press(`csc:${id}`);
    await bot.waitFor(() => bot.answers().filter((a) => a.show_alert).length === 2, 5000, 'two alerts');
    for (const a of bot.answers()) assert.match(a.text, /اقترب موعد النشر \(أقل من 15 دقيقة\)/);
    await bot.settle();
    assert.deepEqual(socialCalls(bot), []);
    assert.ok(!bot.tg('sendMessage').some((c) => c.body.text.startsWith('تأكيد')));
  }));

test('reschedule rejected by SocialAPI (409: publishing started) → says so and syncs the real status', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'scheduled', postId: 'p_77', at: inMinutes(180) });
    bot.mocks.patchPost = () => ({ status: 409, json: { error: { code: 'post.state_invalid', message: 'Post is not editable' } } });
    bot.mocks.getPost = (pid) => ({ status: 200, json: publishedPost(pid) });
    await bot.press(`rsc:${id}`, { messageId: 500 });
    const options = await bot.waitFor(() => bot.tg('editMessageReplyMarkup').find((c) => c.body.message_id === 500), 5000);
    await bot.press(dataOf(options, 'rsa:'), { messageId: 500 });
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد تغيير موعد'), 5000);
    await bot.press(dataOf(confirm, 'rso:'), { messageId: 600 });
    await bot.waitFor(
      () => editedStarting(bot, 600, 'لم يتغيّر الموعد: حالة المنشور في SocialAPI لا تسمح بهذا الإجراء الآن.'),
      10_000,
      'refusal',
    );
    await bot.waitFor(() => sentStarting(bot, `✅ نُشرت المسودة #${id}`), 5000, 'synced outcome');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'published');
  }));

// ---------- إلغاء الجدولة ----------

test('cancel: GET confirms it is still scheduled → DELETE → GET 404 → draft back to pending with its buttons; a second tap deletes nothing', () =>
  withBot(LIVE, async (bot) => {
    const at = inMinutes(180);
    const id = await seed(bot, { status: 'scheduled', postId: 'p_77', at });
    bot.mocks.getPost = (pid) => scheduledPost(pid, at);

    await bot.press(`csc:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, `تأكيد إلغاء جدولة المسودة #${id}`), 5000, 'confirm');
    assert.match(confirm.body.text, /سيُحذف المنشور المجدول من SocialAPI فلا يُنشر، وتعود المسودة معلّقة/);
    assert.deepEqual(socialCalls(bot), [], 'nothing reaches SocialAPI before «تأكيد»');

    const data = dataOf(confirm, 'cso:');
    await bot.press(data, { messageId: 700 });
    const done = await bot.waitFor(() => editedStarting(bot, 700, `🚫 أُلغيت جدولة المسودة #${id}، ولن يُنشر شيء.`), 10_000, 'done');
    assert.match(done.body.text, /\nعادت المسودة #\d+ معلّقة: يمكنك نشرها أو جدولتها من جديد\.$/);
    assert.deepEqual(socialCalls(bot), ['GET /v1/posts/p_77', 'DELETE /v1/posts/p_77', 'GET /v1/posts/p_77']);
    const row = await bot.waitForRow(
      'SELECT status, socialapi_post_id, scheduled_at, telegram_message_id FROM drafts WHERE id = ?',
      [id],
      (r) => r.telegram_message_id === 700,
      'buttons moved to the result message',
    );
    assert.deepEqual({ ...row }, { status: 'pending', socialapi_post_id: null, scheduled_at: null, telegram_message_id: 700 });
    assert.ok(labels(done).includes('✅ انشر الآن'));

    await bot.press(data, { messageId: 700 });
    await bot.waitFor(() => editedStarting(bot, 700, 'لم يعد هذا التأكيد صالحاً'), 5000, 'stale');
    await bot.settle();
    assert.equal(bot.social('DELETE').length, 1);
  }));

test('cancel deletes nothing when SocialAPI says publishing started, the time is near, or a target is already live', () =>
  withBot(LIVE, async (bot) => {
    const at = inMinutes(180);
    const near = inMinutes(10);
    const cases = [
      { remote: (pid) => ({ status: 200, json: { id: pid, status: 'publishing', targets: [] } }), reason: /«قيد النشر» وليست «مجدول»/ },
      { remote: (pid) => scheduledPost(pid, near), reason: /اقترب موعد النشر \(أقل من 15 دقيقة\)/ },
      {
        remote: (pid) => scheduledPost(pid, at, [{ platform: 'twitter', status: 'published' }, { platform: 'linkedin', status: 'pending' }]),
        reason: /بدأ نشر جزء من المنشور/,
      },
    ];
    const ids = [];
    for (const [i, c] of cases.entries()) {
      const id = await seed(bot, { status: 'scheduled', postId: `p_c${i}`, at });
      ids.push(id);
      bot.mocks.getPost = c.remote;
      await bot.press(`csc:${id}`);
      const confirm = await bot.waitFor(() => sentStarting(bot, `تأكيد إلغاء جدولة المسودة #${id}`), 5000);
      await bot.press(dataOf(confirm, 'cso:'), { messageId: 800 + i });
      const msg = await bot.waitFor(() => editedStarting(bot, 800 + i, 'لم يُلغَ شيء: '), 10_000, `refusal ${i}`);
      assert.match(msg.body.text, c.reason);
      await bot.settle();
    }
    assert.equal(bot.social('DELETE').length, 0);
    // (1) الحالة الحقيقية طُبّقت محلياً، (2) حُدّث الموعد المحلي بموعد SocialAPI، (3) بقيت مجدولة
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', ids[0])).status, 'publishing');
    assert.ok(sentStarting(bot, `⏳ ما زال نشر المسودة #${ids[0]} جارياً`));
    await bot.waitForRow('SELECT scheduled_at FROM drafts WHERE id = ?', [ids[1]], (r) => r.scheduled_at === sql(near), 'synced time');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', ids[2])).status, 'scheduled');
  }));

test('cancel reports honestly when SocialAPI does not actually delete the post', () =>
  withBot(LIVE, async (bot) => {
    const at = inMinutes(180);
    const id = await seed(bot, { status: 'scheduled', postId: 'p_77', at });
    bot.mocks.getPost = (pid) => scheduledPost(pid, at);
    bot.mocks.deletePost = () => ({ status: 200, json: { deleted: false, success: false, results: [] } });
    await bot.press(`csc:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إلغاء جدولة'), 5000);
    await bot.press(dataOf(confirm, 'cso:'), { messageId: 700 });
    await bot.waitFor(
      () => editedStarting(bot, 700, '⚠️ لم تُلغَ الجدولة: لم يؤكد SocialAPI الحذف. حالة المنشور الآن «مجدول».'),
      10_000,
      'not cancelled',
    );
    const row = await bot.row('SELECT status, socialapi_post_id FROM drafts WHERE id = ?', id);
    assert.deepEqual({ ...row }, { status: 'scheduled', socialapi_post_id: 'p_77' });
  }));

test('«رجوع» from the time options restores the status buttons; «إلغاء» wording follows the draft status', () =>
  withBot(LIVE, async (bot) => {
    const scheduled = await seed(bot, { status: 'scheduled', postId: 'p_77', at: inMinutes(180) });
    const partial = await seed(bot, { status: 'partial', postId: 'p_5' });
    const pending = await seed(bot, { status: 'pending' });

    await bot.press(`rsc:${scheduled}`, { messageId: 500 });
    await bot.waitFor(() => bot.tg('editMessageReplyMarkup').some((c) => c.body.message_id === 500), 5000);
    await bot.press(`bk:${scheduled}`, { messageId: 500 });
    await bot.waitFor(() => bot.tg('editMessageReplyMarkup').filter((c) => c.body.message_id === 500).length === 2, 5000, 'back');
    const back = bot.tg('editMessageReplyMarkup').filter((c) => c.body.message_id === 500).at(-1);
    assert.deepEqual(labels(back), ['🕒 غيّر الموعد', '🚫 ألغِ الجدولة', '📋 سكربت سناب']);

    const expected = [
      [scheduled, 'أُلغي. بقي الموعد كما هو.'],
      [partial, 'أُلغي. لم تُعد المحاولة.'],
      [pending, 'أُلغي. المسودة ما زالت معلّقة.'],
    ];
    for (const [i, [id, text]] of expected.entries()) {
      await bot.press(`no:${id}`, { messageId: 510 + i });
      await bot.waitFor(() => bot.tg('editMessageText').some((c) => c.body.message_id === 510 + i && c.body.text === text), 5000, text);
    }
    await bot.settle();
    assert.deepEqual(socialCalls(bot), []);
  }));

test('cancel when the post was already deleted from the SocialAPI dashboard → back to pending, no DELETE', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'scheduled', postId: 'p_gone', at: inMinutes(180) });
    bot.mocks.getPost = () => ({ status: 404, json: { error: { code: 'post.not_found', message: 'Post not found' } } });
    await bot.press(`csc:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إلغاء جدولة'), 5000);
    await bot.press(dataOf(confirm, 'cso:'), { messageId: 720 });
    await bot.waitFor(() => editedStarting(bot, 720, 'ℹ️ المنشور لم يعد موجوداً في SocialAPI، فلن يُنشر.'), 10_000, 'gone');
    assert.equal(bot.social('DELETE').length, 0);
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'pending');
  }));

// ---------- إعادة محاولة المنشور الجزئي ----------

test('partial: «أعد محاولة ما فشل» → confirmation names the failed platform, its error and the credit → one retry → published', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    let retried = false;
    bot.mocks.getPost = (pid) => ({ status: 200, json: retried ? publishedPost(pid) : partialPost(pid) });
    bot.mocks.retryPost = () => {
      retried = true;
      return { status: 200, json: { success: true } };
    };

    await bot.press(`shw:${id}`);
    const preview = await bot.waitFor(() => sentStarting(bot, `📝 مسودة #${id}`), 5000, 'preview');
    assert.deepEqual(labels(preview), ['🔁 أعد محاولة ما فشل', '📋 سكربت سناب']);

    await bot.press(`prt:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إعادة محاولة النشر'), 5000, 'confirm');
    assert.match(confirm.body.text, /^تأكيد إعادة محاولة النشر على لينكدن للمسودة #\d+؟ \(المتبقي من رصيد الشهر: 6\)\n/);
    assert.match(confirm.body.text, /وتستهلك منشوراً واحداً من الرصيد\.\nسبب الفشل السابق في لينكدن: LinkedIn timed out$/);
    assert.equal(bot.social('POST', '/v1/posts/p_5/retry').length, 0, 'no retry before «تأكيد»');

    await bot.press(dataOf(confirm, 'pro:'), { messageId: 900 });
    const done = await bot.waitFor(() => editedStarting(bot, 900, `✅ نُشرت المسودة #${id}`), 20_000, 'published');
    assert.match(done.body.text, /✅ لينكدن: https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:9/);
    assert.equal(bot.social('POST', '/v1/posts/p_5/retry').length, 1);
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'published');
    assert.deepEqual(labels(done), ['📋 سكربت سناب']);
  }));

test('retry is blocked in DRY_RUN and when no credit is left', async () => {
  await withBot({}, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    await bot.press(`prt:${id}`);
    await bot.waitFor(() => bot.texts().includes('🧪 وضع التجربة مفعّل: إعادة المحاولة تنشر فعلياً، لذلك لا تعمل فيه.'), 5000);
    await bot.settle();
    assert.deepEqual(socialCalls(bot), []);
  });
  await withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    bot.mocks.usage = { posts_used: 10, posts_limit: 10 };
    bot.mocks.getPost = (pid) => ({ status: 200, json: partialPost(pid) });
    await bot.press(`prt:${id}`);
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('⛔️ لا يمكن إعادة المحاولة: نفد رصيد')), 5000);
    await bot.settle();
    assert.ok(!bot.texts().some((t) => t.startsWith('تأكيد')));
    assert.equal(bot.social('POST', '/v1/posts/p_5/retry').length, 0);
  });
});

test('double-tapping «تأكيد» on a retry sends one retry (one credit)', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    let retried = false;
    bot.mocks.getPost = (pid) => ({ status: 200, json: retried ? publishedPost(pid) : partialPost(pid) });
    bot.mocks.retryPost = () => {
      retried = true;
      return { status: 200, json: { success: true } };
    };
    await bot.press(`prt:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إعادة محاولة النشر'), 5000);
    const data = dataOf(confirm, 'pro:');
    bot.mocks.answerBarrier = 2;
    await Promise.all([bot.press(data, { messageId: 901 }), bot.press(data, { messageId: 901 })]);
    await bot.waitFor(() => editedStarting(bot, 901, `✅ نُشرت المسودة #${id}`), 20_000, 'published');
    await bot.waitFor(
      () => bot.texts().some((t) => /^(يجري تنفيذ هذا الطلب بالفعل|لم يعد هذا التأكيد صالحاً)/.test(t)),
      5000,
      'second tap refused',
    );
    assert.equal(bot.social('POST', '/v1/posts/p_5/retry').length, 1);
  }));

test('a retry without a final result yet stays «قيد النشر»; «تحقق من الحالة» settles it later', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    let remote = 'partial';
    bot.mocks.getPost = (pid) => ({
      status: 200,
      json: remote === 'published' ? publishedPost(pid) : remote === 'publishing' ? { id: pid, status: 'publishing' } : partialPost(pid),
    });
    await bot.press(`prt:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إعادة محاولة النشر'), 5000);
    await bot.press(dataOf(confirm, 'pro:'), { messageId: 950 });
    const waiting = await bot.waitFor(() => editedStarting(bot, 950, `⏳ أُرسلت إعادة المحاولة للمسودة #${id}`), 30_000, 'no result yet');
    assert.deepEqual(labels(waiting), ['🔄 تحقق من الحالة', '📋 سكربت سناب']);
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'publishing');

    remote = 'publishing';
    await bot.press(`chk:${id}`, { messageId: 950 });
    await bot.waitFor(() => bot.answers().some((a) => a.text === 'ما زال النشر جارياً. تحقق بعد قليل.'), 5000, 'still publishing');

    remote = 'published';
    await bot.press(`chk:${id}`, { messageId: 950 });
    await bot.waitFor(() => editedStarting(bot, 950, `✅ نُشرت المسودة #${id}`), 5000, 'settled');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'published');
  }));

test('retry refused by SocialAPI (409) restores «جزئي», says why and syncs the real status', () =>
  withBot(LIVE, async (bot) => {
    const id = await seed(bot, { status: 'partial', postId: 'p_5' });
    let remote = 'partial';
    bot.mocks.getPost = (pid) => ({ status: 200, json: remote === 'published' ? publishedPost(pid) : partialPost(pid) });
    bot.mocks.retryPost = () => {
      remote = 'published'; // أُعيدت المحاولة من اللوحة في الأثناء
      return { status: 409, json: { error: { code: 'post.state_invalid', message: 'not retryable' } } };
    };
    await bot.press(`prt:${id}`);
    const confirm = await bot.waitFor(() => sentStarting(bot, 'تأكيد إعادة محاولة النشر'), 5000);
    await bot.press(dataOf(confirm, 'pro:'), { messageId: 960 });
    await bot.waitFor(() => editedStarting(bot, 960, 'لم تُعد المحاولة: حالة المنشور في SocialAPI لا تسمح بهذا الإجراء الآن.'), 10_000);
    await bot.waitFor(() => sentStarting(bot, `✅ نُشرت المسودة #${id}`), 5000, 'synced');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = ?', id)).status, 'published');
  }));

// ---------- أزرار رسائل النتيجة ----------

test('outcome messages carry the buttons of the new status: scheduled → change/cancel, partial → retry', () =>
  withBot(LIVE, async (bot) => {
    const a = await seed(bot, { status: 'pending' });
    await bot.press(`sch:${a}`, { messageId: 10 });
    const options = await bot.waitFor(
      () => bot.tg('editMessageReplyMarkup').find((c) => c.body.message_id === 10 && kbOf(c).some((b) => b.callback_data.startsWith('sat:'))),
      5000,
    );
    await bot.press(dataOf(options, 'sat:'), { messageId: 10 });
    const conf = await bot.waitFor(() => sentStarting(bot, 'تأكيد جدولة النشر'), 5000);
    await bot.press(dataOf(conf, 'oks:'), { messageId: 11 });
    const scheduled = await bot.waitFor(() => editedStarting(bot, 11, `🕒 جُدولت المسودة #${a}`), 10_000, 'scheduled');
    assert.deepEqual(labels(scheduled), ['🕒 غيّر الموعد', '🚫 ألغِ الجدولة', '📋 سكربت سناب']);

    const b = await seed(bot, { status: 'pending' });
    bot.mocks.createPost = () => ({ status: 207, json: partialPost('p_part') });
    await bot.press(`pub:${b}`);
    const conf2 = await bot.waitFor(() => sentStarting(bot, 'تأكيد النشر على'), 5000);
    await bot.press(dataOf(conf2, 'okn:'), { messageId: 12 });
    const partial = await bot.waitFor(() => editedStarting(bot, 12, `⚠️ نُشرت المسودة #${b} جزئياً`), 10_000, 'partial');
    assert.deepEqual(labels(partial), ['🔁 أعد محاولة ما فشل', '📋 سكربت سناب']);
    await bot.waitForRow('SELECT telegram_message_id FROM drafts WHERE id = ?', [b], (r) => r.telegram_message_id === 12, 'buttons moved');
  }));

// ---------- التذكير ----------

test('the inactivity reminder leads with ready drafts («عرض» for the newest three) before new topics', () =>
  withBot({}, async (bot) => {
    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('last_published_at', datetime('now', '-6 days'))").run();
    for (let i = 0; i < 4; i++) await seed(bot, { status: 'pending', idea: false });
    await seed(bot, { status: 'failed', idea: false });
    await bot.scheduled('0 6 * * *');
    const reminder = await bot.waitFor(() => sentStarting(bot, '⏰'), 5000, 'reminder');
    assert.equal(
      reminder.body.text,
      '⏰ مرّ 6 أيام على آخر نشر. لديك 4 مسودات جاهزة للنشر، أحدثها:\n• #4 — «تغريدة أولى»\n• #3 — «تغريدة أولى»\n• #2 — «تغريدة أولى»\nافتح إحداها وانشرها، أو اطلب موضوعاً جديداً.',
    );
    assert.deepEqual(
      reminder.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data)),
      [['shw:4', 'shw:3', 'shw:2'], ['plan', 'ideas']],
    );

    await bot.db.prepare('DELETE FROM drafts WHERE id BETWEEN 2 AND 4').run();
    await bot.scheduled('0 6 * * *');
    const second = await bot.waitFor(() => bot.tg('sendMessage').filter((c) => c.body.text.startsWith('⏰')).at(1), 5000);
    assert.match(second.body.text, /لديك مسودة واحدة جاهزة للنشر:\n• #1 — «تغريدة أولى»\n/);
  }));

// ---------- أرشفة الأفكار ----------

test('/ideas «أرشف» archives in place with an undo button; «تراجع» restores it; a non-new idea is refused', () =>
  withBot({}, async (bot) => {
    await bot.sendText('فكرة أولى');
    await bot.settle();
    await bot.sendText('فكرة ثانية');
    await bot.settle();
    await bot.sendText('/ideas');
    const list = await bot.waitFor(() => sentStarting(bot, '💡 أحدث الأفكار'), 5000);
    const rowsOf = (call) => call.body.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data));
    const edits = () => bot.tg('editMessageReplyMarkup').filter((c) => c.body.message_id === 321);

    await bot.press('arc:2', { messageId: 321, markup: list.body.reply_markup });
    const archived = await bot.waitFor(() => edits()[0], 5000, 'archived keyboard');
    assert.deepEqual(rowsOf(archived), [['una:2'], ['fmt:1', 'arc:1']]);
    assert.equal(kbOf(archived)[0].text, '↩️ تراجع عن أرشفة #2');
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 2')).status, 'archived');
    await bot.waitFor(() => bot.answers().some((a) => a.text === '🗄 أُرشفت الفكرة #2' && !a.show_alert), 5000);

    await bot.press('una:2', { messageId: 321, markup: archived.body.reply_markup });
    const restored = await bot.waitFor(() => edits()[1], 5000, 'restored keyboard');
    assert.deepEqual(rowsOf(restored), [['fmt:2', 'arc:2'], ['fmt:1', 'arc:1']]);
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 2')).status, 'new');

    await bot.db.prepare("UPDATE ideas SET status = 'drafted' WHERE id = 1").run();
    await bot.press('arc:1', { messageId: 321, markup: restored.body.reply_markup });
    await bot.waitFor(() => bot.answers().some((a) => a.show_alert && a.text === 'حالة الفكرة #1 الآن: صيغت منها مسودة.'), 5000);
    await bot.settle();
    assert.equal(edits().length, 2, 'refused → keyboard untouched');
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 1')).status, 'drafted');
  }));

// ---------- سكربت سناب ----------

test('«📋 سكربت سناب» sends each frame as a tap-to-copy block with exact UTF-16 offsets', () =>
  withBot({}, async (bot) => {
    const frames = ['إطار أول\nسطر ثانٍ', 'إطار 😀 ثانٍ', 'ثالث'];
    const id = await seed(bot, { status: 'published', postId: 'p_1', snap: frames });
    await bot.press(`snp:${id}`);
    const msg = await bot.waitFor(() => sentStarting(bot, `📋 سكربت سناب — المسودة #${id}`), 5000);
    const { text, entities } = msg.body;
    assert.equal(entities.length, frames.length);
    entities.forEach((e, i) => {
      assert.equal(e.type, 'pre');
      assert.equal(text.slice(e.offset, e.offset + e.length), frames[i]);
    });

    const none = await seed(bot, { status: 'pending', snap: [] });
    await bot.press(`snp:${none}`);
    await bot.waitFor(() => bot.answers().some((a) => a.show_alert && a.text === 'لا يوجد سكربت سناب لهذه المسودة.'), 5000);
  }));

// ---------- النسخة الاحتياطية ----------

test('/export sends a JSON backup of all ideas and drafts as a document, logging counts only', () =>
  withBot({}, async (bot) => {
    await bot.sendText('فكرة للنسخ الاحتياطي');
    await bot.settle();
    await seed(bot, { status: 'pending' });
    await bot.sendText('/export');
    const doc = await bot.waitFor(() => bot.tg('sendDocument')[0], 5000, 'document');
    assert.equal(doc.form.chat_id, String(OWNER));
    assert.match(doc.form.caption, /^💾 نسخة احتياطية حتى .+\nالأفكار: 2 — المسودات: 1\nاحفظ الملف في مكان آمن/);
    assert.match(doc.form.document.name, /^social-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(doc.form.document.type, 'application/json');
    const data = JSON.parse(doc.form.document.text);
    assert.equal(data.format, 'social-backup/1');
    assert.deepEqual(data.ideas.map((i) => i.text), ['فكرة للنسخ الاحتياطي', 'فكرة']);
    assert.deepEqual(data.drafts[0].x_segments, ['تغريدة أولى', 'ثانية']);
    assert.deepEqual(data.drafts[0].snap_script, SNAP);
    assert.equal(data.drafts[0].status, 'pending');
    await bot.settle();
    assert.ok(!JSON.stringify(bot.workerLogs).includes('فكرة للنسخ الاحتياطي'), 'texts are never logged');
  }));
