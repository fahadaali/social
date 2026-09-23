// اختبارات طرفية على الـ Worker المجمّع فعلياً (npm run test:e2e).
// تغطي معايير قبول المرحلة 1 (SPEC §12) بقدر ما يمكن دون حسابات حقيقية.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicMessage, draftOutput, OWNER, startBot, STRANGER } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

/** فكرة ← «صُغها الآن» ← معاينة. يعيد نص المعاينة. */
async function makeDraft(bot, text = 'الحوكمة في الجمعيات تبدأ من مصفوفة الصلاحيات') {
  await bot.sendText(text);
  await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة')), 10_000, 'idea saved');
  await bot.press(bot.button('صُغها الآن'));
  const preview = await bot.waitFor(
    () => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📝 مسودة')),
    15_000,
    'preview',
  );
  await bot.settle();
  return preview.body.text;
}

// ---------- الأمان (SPEC §4) — معيار القبول 1 ----------

test('webhook rejects a missing or wrong secret token with 401', () =>
  withBot({}, async (bot) => {
    assert.equal((await bot.post({ update_id: 1 }, {})).status, 401);
    assert.equal((await bot.post({ update_id: 1 }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
    const r = await bot.mf.dispatchFetch('https://bot.example/webhook', { method: 'GET' });
    assert.equal(r.status, 405);
    assert.equal((await bot.mf.dispatchFetch('https://bot.example/other')).status, 404);
    await bot.settle(200);
    assert.equal(bot.calls.length, 0);
  }));

test('acceptance 1: messages and button presses from anyone but the owner get no reply at all', () =>
  withBot({}, async (bot) => {
    assert.equal((await bot.sendText('مرحبا', STRANGER)).status, 200);
    assert.equal((await bot.press('pub:1', { from: STRANGER })).status, 200);
    await bot.post({ update_id: 999, message: { message_id: 1, date: 1, from: { id: OWNER }, chat: { id: -100, type: 'group' }, text: 'في مجموعة' } });
    await bot.settle(500);
    assert.equal(bot.calls.length, 0, 'no outbound call of any kind');
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM processed_updates')).n, 0);
  }));

test('an owner-less deployment (ALLOWED_TELEGRAM_USER_ID empty) ignores everyone', () =>
  withBot({ vars: { ALLOWED_TELEGRAM_USER_ID: '' } }, async (bot) => {
    await bot.sendText('مرحبا', OWNER);
    await bot.settle(400);
    assert.equal(bot.calls.length, 0);
  }));

test('duplicate update_id is processed once', () =>
  withBot({}, async (bot) => {
    const update = { update_id: 777, message: { message_id: 5, date: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: 'فكرة مكررة' } };
    await bot.post(update);
    await bot.post(update);
    await bot.settle();
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 1);
    assert.equal(bot.anthropic('classify').length, 1);
  }));

// ---------- الأفكار والصياغة — معيار القبول 2 ----------

test('/start explains the bot and warns about DRY_RUN and unfilled config', () =>
  withBot({}, async (bot) => {
    await bot.sendText('/start');
    const msg = await bot.waitFor(() => bot.lastTg('sendMessage'), 5000, 'welcome');
    assert.match(msg.body.text, /لا يُنشر ولا يُجدول أي شيء إلا بعد ضغطك «تأكيد»/);
    assert.match(msg.body.text, /وضع التجربة مفعّل/);
    assert.match(msg.body.text, /config\/pillars\.md/);
  }));

test('acceptance 2: text idea → saved + classified → «صُغها الآن» → full draft preview with buttons', () =>
  withBot({}, async (bot) => {
    const preview = await makeDraft(bot);
    assert.ok(preview.startsWith('📝 مسودة #1 — المحور: الحوكمة (نسخة 1)'));
    assert.match(preview, /【X — ثريد من 3 تغريدات】\n1\/ الحوكمة ليست/);
    assert.match(preview, /【LinkedIn】/);
    assert.match(preview, /【سناب — للنشر اليدوي】/);
    assert.match(preview, /🖼 يُقترح تصميم: بطاقة تلخّص الخطوات الثلاث/);
    assert.ok(bot.tg('sendMessage').some((c) => c.body.text.startsWith('⏳ جاري الصياغة')), 'placeholder first');
    const labels = bot.lastKeyboard().map((b) => b.text);
    for (const l of ['✅ انشر الآن', '🕒 جدول', '✏️ عدّل', '🔁 صياغة جديدة', '🖼 أرفق صورة', 'X ✓', 'LinkedIn ✓', '🗑 تجاهل']) {
      assert.ok(labels.includes(l), l);
    }
    const draft = await bot.row('SELECT * FROM drafts WHERE id = 1');
    assert.equal(draft.status, 'pending');
    assert.equal(draft.revision, 0);
    assert.equal(JSON.parse(draft.x_segments).length, 3);
    assert.equal(draft.needs_visual, 1);
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 1')).status, 'drafted');
  }));

test('Claude requests: JSON schema output, cached system prompt, fast model for classify, no thinking for drafting', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    const [classify] = bot.anthropic('classify');
    const [draft] = bot.anthropic('draft');
    assert.equal(classify.body.model, 'claude-haiku-4-5-20251001');
    assert.equal(classify.body.thinking, undefined);
    assert.equal(draft.body.model, 'claude-sonnet-5');
    assert.deepEqual(draft.body.thinking, { type: 'disabled' });
    assert.equal(draft.body.output_config.format.type, 'json_schema');
    assert.deepEqual(draft.body.system[0].cache_control, { type: 'ephemeral' });
    assert.match(draft.body.system[0].text, /يُمنع اختلاق أي رقم مادة نظامية/);
    assert.equal(draft.headers['anthropic-version'], '2023-06-01');
    assert.equal(draft.headers['x-api-key'], 'sk-ant-test');
    assert.ok(draft.body.max_tokens > 0 && draft.body.max_tokens <= 4096);
  }));

test('a tweet over the X limit triggers exactly one corrective retry that names the error', () =>
  withBot({}, async (bot) => {
    bot.mocks.anthropic.push(
      null, // classify → الرد الافتراضي
      () => draftOutput({ x_segments: ['ح'.repeat(300), 'ثانية'] }),
      () => draftOutput({ x_segments: ['نسخة مختصرة', 'ثانية'] }),
    );
    const preview = await makeDraft(bot);
    const drafts = bot.anthropic('draft');
    assert.equal(drafts.length, 2);
    const fix = drafts[1].body.messages;
    assert.equal(fix.length, 3);
    assert.equal(fix[1].role, 'assistant');
    assert.match(fix[2].content, /التغريدة 1 طولها 300 حرفاً والحد 280/);
    assert.match(preview, /1\/ نسخة مختصرة/);
  }));

test('Anthropic overload: one retry after ~2s, then a clear message with a «أعد المحاولة» button', () =>
  withBot({}, async (bot) => {
    await bot.sendText('فكرة');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة')), 10_000);
    const overloaded = () => ({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    bot.mocks.anthropic.push(overloaded, overloaded);
    const started = Date.now();
    await bot.press(bot.button('صُغها الآن'));
    const failed = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('❌ تعذّرت الصياغة')), 15_000, 'failure');
    assert.ok(Date.now() - started >= 1900, 'waited ~2s before retrying');
    assert.equal(bot.anthropic('draft').length, 2);
    assert.match(failed.body.text, /خدمة Claude مشغولة الآن/);
    assert.equal(failed.body.reply_markup.inline_keyboard[0][0].callback_data, 'rt:f:1');
    // «أعد المحاولة» تنجح الآن
    await bot.press('rt:f:1');
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📝 مسودة #1')), 15_000, 'retry preview');
  }));

// ---------- التعديل والصياغة الجديدة — معيار القبول 5 ----------

test('acceptance 5: ✏️ edit with notes revises only per the notes and bumps revision', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    const oldPreviewId = (await bot.row('SELECT telegram_message_id AS m FROM drafts WHERE id = 1')).m;
    await bot.press(bot.button('✏️ عدّل'));
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('✏️ اكتب ملاحظاتك على المسودة #1')), 5000);
    assert.ok((await bot.row("SELECT value FROM state WHERE key = 'awaiting_edit'")).value.includes('"draft_id":1'));
    bot.mocks.anthropic.push(() => draftOutput({ x_segments: ['نسخة معدّلة بناء على الملاحظات'] }));
    await bot.sendText('اجعل الافتتاحية أقصر واحذف الإيموجي');
    const preview = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.includes('(نسخة 2)')), 15_000, 'revised preview');
    assert.match(preview.body.text, /نسخة معدّلة بناء على الملاحظات/);
    const revise = bot.anthropic('draft').at(-1);
    assert.match(revise.body.messages[0].content, /<owner_notes>\nاجعل الافتتاحية أقصر واحذف الإيموجي\n<\/owner_notes>/);
    assert.match(revise.body.messages[0].content, /غيّر فقط ما تطلبه الملاحظات/);
    const d = await bot.row('SELECT revision FROM drafts WHERE id = 1');
    assert.equal(d.revision, 1);
    assert.equal((await bot.row("SELECT COUNT(*) AS n FROM state WHERE key = 'awaiting_edit'")).n, 0);
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 1, 'notes were not saved as a new idea');
    await bot.settle();
    assert.ok(
      bot.tg('editMessageReplyMarkup').some((c) => c.body.message_id === oldPreviewId && c.body.reply_markup.inline_keyboard.length === 0),
      'old preview buttons removed',
    );
    // الأزرار الحيّة تنتقل إلى المعاينة الجديدة (كتابة D1 تلي تعديل الرسالة)
    await bot.waitForRow('SELECT telegram_message_id AS m FROM drafts WHERE id = 1', [], (r) => r.m !== oldPreviewId, 'new preview id');
  }));

test('🔁 regenerate asks for a different angle and bumps revision', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('🔁 صياغة جديدة'));
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.includes('(نسخة 2)')), 15_000, 'regenerated');
    assert.match(bot.anthropic('draft').at(-1).body.messages[0].content, /بزاوية مختلفة عن النسخة السابقة/);
    assert.equal((await bot.row('SELECT revision FROM drafts WHERE id = 1')).revision, 1);
  }));

// ---------- النشر — معيار القبول 3 ----------

test('acceptance 3: DRY_RUN publish → validate → confirm → SocialAPI draft only (no publish_now, no credit)', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('✅ انشر الآن'));
    const confirm = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000, 'confirmation');
    assert.match(confirm.body.text, /^تأكيد النشر على X ولينكدن؟ \(المتبقي من رصيد الشهر: 6\)/);
    assert.match(confirm.body.text, /🧪 وضع التجربة مفعّل/);
    assert.equal(bot.social('POST', '/v1/posts').length, 0, 'nothing is created before «تأكيد»');
    assert.equal(bot.social('POST', '/v1/posts/validate').length, 1, 'validated before confirmation');

    await bot.press(bot.button('تأكيد'), { messageId: 5555 });
    const done = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('🧪 وضع التجربة: حُفظت كمسودة')), 10_000, 'dry-run done');
    assert.match(done.body.text, /ولم تُنشر/);
    const [create] = bot.social('POST', '/v1/posts');
    assert.equal(create.body.publish_now, undefined);
    assert.equal(create.body.scheduled_at, undefined);
    assert.equal(create.headers.authorization, 'Bearer sapi_key_test');
    assert.deepEqual(create.body.targets[0].platform_data, {
      thread: [
        { text: 'ثلاث خطوات عملية لبدء الحوكمة في منظمتك.', media_ids: [] },
        { text: 'ابدأ بمصفوفة صلاحيات واضحة.', media_ids: [] },
      ],
    });
    assert.equal(create.body.targets[0].account_id, 'acc_x');
    assert.equal(create.body.targets[1].account_id, 'acc_li');
    assert.equal(bot.social('POST', '/v1/posts/validate').length, 2, 'validated again right before creating');
    const d = await bot.row('SELECT status, socialapi_post_id FROM drafts WHERE id = 1');
    assert.equal(d.status, 'pending');
    assert.equal(d.socialapi_post_id, 'p_1');
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'last_published_at'"), null);
  }));

test('live publish: publish_now → poll status (5s) → permalinks, D1 + last_published_at updated', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    await bot.press(bot.button('تأكيد'), { messageId: 6000 });
    const done = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('✅ نُشرت المسودة #1')), 20_000, 'published');
    assert.match(done.body.text, /X: https:\/\/x\.com\/owner\/status\/1/);
    assert.match(done.body.text, /لينكدن: https:\/\/www\.linkedin\.com/);
    assert.equal(bot.social('POST', '/v1/posts')[0].body.publish_now, true);
    assert.ok(bot.social('GET', '/v1/posts/p_1').length >= 1);
    const d = await bot.row('SELECT status, published_at FROM drafts WHERE id = 1');
    assert.equal(d.status, 'published');
    assert.ok(d.published_at);
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 1')).status, 'published');
    assert.ok((await bot.row("SELECT value FROM state WHERE key = 'last_published_at'")).value);
  }));

test('double-tapping «تأكيد» creates only one post', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    const data = bot.button('تأكيد');
    bot.mocks.answerBarrier = 2; // الضغطتان تتقدمان معاً إلى قراءة المسودة
    await Promise.all([bot.press(data, { messageId: 7000 }), bot.press(data, { messageId: 7000 })]);
    await bot.settle(800, 25_000);
    assert.equal(bot.social('POST', '/v1/posts').length, 1);
  }));

test('a confirmation becomes invalid if the draft changes after it was shown', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    const stale = bot.button('تأكيد');
    await bot.press('tgl:1:x');
    await bot.settle();
    await bot.press(stale, { messageId: 7100 });
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('لم يعد هذا التأكيد صالحاً')), 10_000, 'stale rejected');
    assert.equal(bot.social('POST', '/v1/posts').length, 0);
  }));

test('credit guard: 0 remaining blocks publishing; ≤2 adds a warning', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    bot.mocks.usage = { posts_used: 10, posts_limit: 10 };
    await bot.press(bot.button('✅ انشر الآن'));
    const blocked = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('⛔️ لا يمكن النشر')), 10_000, 'blocked');
    assert.match(blocked, /المتبقي 0/);
    assert.equal(bot.social('POST', '/v1/posts/validate').length, 0);
    bot.mocks.usage = { posts_used: 8, posts_limit: 10 };
    await bot.press('pub:1');
    const warn = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    assert.match(warn.body.text, /المتبقي من رصيد الشهر: 2/);
    assert.match(warn.body.text, /رصيد الشهر يوشك على النفاد/);
  }));

test('validation errors are shown and nothing is published', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    bot.mocks.validate = { valid: false, errors: [{ platform: 'linkedin', field: 'text', message: 'exceeds limit' }], warnings: [] };
    await bot.press(bot.button('✅ انشر الآن'));
    const msg = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('❌ لن يُنشر')), 10_000, 'validation error');
    assert.match(msg, /\[لينكدن · text\] exceeds limit/);
    assert.equal(bot.social('POST', '/v1/posts').length, 0);
  }));

test('SocialAPI 429 billing.post_limit → spec message, no retry, draft back to pending', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    bot.mocks.createPost = () => ({ status: 429, json: { error: { code: 'billing.post_limit', message: 'limit' }, request_id: 'r1' } });
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    await bot.press(bot.button('تأكيد'), { messageId: 7200 });
    const msg = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('❌ لم يُنشر')), 10_000, 'error');
    assert.equal(msg, '❌ لم يُنشر: بلغتَ حد منشورات الشهر في SocialAPI.');
    assert.equal(bot.social('POST', '/v1/posts').length, 1);
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = 1')).status, 'pending');
  }));

test('SocialAPI 5xx on create is treated as uncertain: draft marked failed with a check-the-dashboard warning', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    bot.mocks.createPost = () => ({ status: 502, json: { error: { code: 'system.internal', message: 'x' } } });
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    await bot.press(bot.button('تأكيد'), { messageId: 7300 });
    await bot.waitFor(() => bot.texts().some((t) => t.includes('راجع لوحة SocialAPI قبل إعادة المحاولة')), 10_000, 'uncertain');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = 1')).status, 'failed');
  }));

// ---------- الجدولة ----------

test('schedule: options keyboard → confirmation → scheduled_at RFC3339 → status scheduled', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('🕒 جدول'), { messageId: 1 });
    await bot.waitFor(() => bot.lastTg('editMessageReplyMarkup')?.body.reply_markup.inline_keyboard.flat().some((b) => b.text.includes('8ص')), 5000, 'options');
    const options = bot.lastTg('editMessageReplyMarkup').body.reply_markup.inline_keyboard.flat();
    assert.ok(options.some((b) => b.text === '↩️ رجوع'));
    const pick = options.find((b) => b.callback_data.startsWith('sat:'));
    const unix = Number(pick.callback_data.split(':')[2]);
    await bot.press(pick.callback_data, { messageId: 1 });
    const confirm = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد جدولة النشر')), 10_000, 'confirm');
    assert.match(confirm.body.text, /بتوقيت الرياض/);
    await bot.press(bot.button('تأكيد'), { messageId: 7400 });
    const done = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('🕒 جُدولت المسودة #1')), 10_000, 'scheduled');
    assert.match(done, /بتوقيت الرياض/);
    const [create] = bot.social('POST', '/v1/posts');
    assert.equal(create.body.scheduled_at, new Date(unix * 1000).toISOString().replace('.000Z', 'Z'));
    assert.equal(create.body.publish_now, undefined);
    const d = await bot.row('SELECT status, scheduled_at FROM drafts WHERE id = 1');
    assert.equal(d.status, 'scheduled');
    assert.equal(d.scheduled_at, new Date(unix * 1000).toISOString().slice(0, 19).replace('T', ' '));
    // المسودة المجدولة لا تقبل تعديلاً
    await bot.press('edt:1');
    await bot.waitFor(() => bot.lastTg('answerCallbackQuery')?.body.text?.startsWith('🕒 مجدولة'), 5000, 'locked');
  }));

// ---------- الصور — معيار القبول 6 ----------

test('acceptance 6: 🖼 attach → photo downloaded in the Worker → uploaded server-side → sent on LinkedIn only', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('🖼 أرفق صورة'));
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('🖼 أرسل صورة التصميم')), 5000);
    await bot.sendPhoto();
    const ok = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('✅ أُرفقت الصورة بالمسودة #1')), 10_000, 'attached');
    assert.ok(ok.body.reply_markup.inline_keyboard.flat().some((b) => b.text === '🖼 استبدل الصورة'));
    assert.equal(bot.lastTg('getFile').body.file_id, 'large', 'largest photo size used');
    const download = bot.calls.find((c) => c.path.startsWith('/file/'));
    assert.ok(download);
    const [upload] = bot.social('POST', '/v1/media/upload');
    assert.deepEqual(upload.form.file, { name: 'draft-1.jpg', type: 'image/jpeg', size: 6 });
    assert.ok(!JSON.stringify(bot.calls.filter((c) => c.host !== 'api.telegram.org')).includes('123456:TEST-bot-token'), 'bot token never leaves Telegram calls');
    assert.equal((await bot.row('SELECT media_id FROM drafts WHERE id = 1')).media_id, 'med_1');

    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    await bot.press(bot.button('تأكيد'), { messageId: 8000 });
    await bot.waitFor(() => bot.social('POST', '/v1/posts').length, 10_000);
    const [create] = bot.social('POST', '/v1/posts');
    assert.equal(create.body.targets[0].media, undefined, 'no media on X');
    assert.deepEqual(create.body.targets[1].media, [{ source_type: 'media_id', source: 'med_1' }]);
  }));

test('image sent as a file (document) keeps its type', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press('img:1');
    await bot.settle();
    await bot.sendPhoto({ asDocument: true });
    await bot.waitFor(() => bot.social('POST', '/v1/media/upload').length, 10_000);
    assert.deepEqual(bot.social('POST', '/v1/media/upload')[0].form.file, { name: 'draft-1.png', type: 'image/png', size: 6 });
  }));

test('a photo without awaiting_image becomes a photo idea from its caption; no caption → asks for one', () =>
  withBot({}, async (bot) => {
    await bot.sendPhoto({ caption: 'فكرة من صورة: لجان المراجعة' });
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة #1')), 10_000);
    const idea = await bot.row('SELECT text, source FROM ideas WHERE id = 1');
    assert.deepEqual({ ...idea }, { text: 'فكرة من صورة: لجان المراجعة', source: 'photo' });
    await bot.sendPhoto();
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('لم أحفظ الصورة')), 5000);
    assert.equal(bot.social('POST', '/v1/media/upload').length, 0);
  }));

// ---------- أزرار أخرى ----------

test('platform toggles change the post targets', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press('tgl:1:x', { messageId: 1 });
    await bot.waitFor(() => bot.lastTg('editMessageReplyMarkup')?.body.reply_markup.inline_keyboard.flat().some((b) => b.text === 'X ✗'), 5000);
    assert.equal((await bot.row('SELECT platforms FROM drafts WHERE id = 1')).platforms, '["linkedin"]');
    await bot.press('pub:1');
    const confirm = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    assert.match(confirm.body.text, /^تأكيد النشر على لينكدن؟/);
    await bot.press(bot.button('تأكيد'), { messageId: 8100 });
    await bot.waitFor(() => bot.social('POST', '/v1/posts').length, 10_000);
    assert.deepEqual(bot.social('POST', '/v1/posts')[0].body.targets.map((t) => t.account_id), ['acc_li']);
  }));

test('🗑 reject marks the draft rejected and archives the idea', () =>
  withBot({}, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('🗑 تجاهل'), { messageId: 1 });
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('🗑 تم تجاهل المسودة #1')), 5000);
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = 1')).status, 'rejected');
    assert.equal((await bot.row('SELECT status FROM ideas WHERE id = 1')).status, 'archived');
  }));

test('/ideas lists new ideas with «صُغها» and «أرشف» buttons', () =>
  withBot({}, async (bot) => {
    await bot.sendText('فكرة أولى');
    await bot.settle();
    await bot.sendText('فكرة ثانية');
    await bot.settle();
    await bot.sendText('/ideas');
    const msg = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('💡 أحدث الأفكار')), 5000);
    assert.deepEqual(
      msg.body.reply_markup.inline_keyboard.map((row) => row.map((b) => b.callback_data)),
      [['fmt:2', 'arc:2'], ['fmt:1', 'arc:1']],
    );
  }));

// ---------- المهمة اليومية ----------

test('daily cron: resolves stuck publishing posts, reminds after REMINDER_AFTER_DAYS, cleans old updates', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await bot.db.prepare("INSERT INTO ideas (text, pillar, status) VALUES ('فكرة', 'الحوكمة', 'drafted')").run();
    await bot.db
      .prepare(`INSERT INTO drafts (idea_id, x_segments, linkedin_text, status, socialapi_post_id) VALUES (1, '["t"]', 'l', 'publishing', 'p_9')`)
      .run();
    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('last_published_at', datetime('now', '-10 days'))").run();
    await bot.db.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (1, datetime('now', '-8 days')), (2, datetime('now'))").run();
    await bot.scheduled('0 6 * * *');
    await bot.settle();
    assert.ok(bot.texts().some((t) => t.startsWith('✅ نُشرت المسودة #1')), 'stuck post resolved and reported');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = 1')).status, 'published');
    // بعد النشر يصبح آخر نشر اليوم فلا تذكير
    assert.ok(!bot.texts().some((t) => t.startsWith('⏰')));
    assert.deepEqual((await bot.db.prepare('SELECT update_id FROM processed_updates').all()).results.map((r) => r.update_id), [2]);
  }));

test('daily cron reminder: sent after 5 days with both buttons; not when paused or a post is scheduled', () =>
  withBot({}, async (bot) => {
    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('last_published_at', datetime('now', '-5 days'))").run();
    await bot.scheduled('0 6 * * *');
    const reminder = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('⏰')), 5000, 'reminder');
    assert.match(reminder.body.text, /مرّ 5 أيام على آخر نشر/);
    assert.deepEqual(reminder.body.reply_markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [
      ['اقترح موضوعاً', 'plan'],
      ['أفكاري', 'ideas'],
    ]);

    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('reminders_paused', '1')").run();
    const before = bot.tg('sendMessage').length;
    await bot.scheduled('0 6 * * *');
    await bot.settle();
    assert.equal(bot.tg('sendMessage').length, before, 'paused → no reminder');

    await bot.db.prepare("DELETE FROM state WHERE key = 'reminders_paused'").run();
    await bot.db
      .prepare(`INSERT INTO drafts (x_segments, linkedin_text, status, scheduled_at) VALUES ('["t"]', 'l', 'scheduled', datetime('now', '+1 day'))`)
      .run();
    await bot.scheduled('0 6 * * *');
    await bot.settle();
    assert.equal(bot.tg('sendMessage').length, before, 'scheduled post exists → no reminder');
  }));

test('reminder button «اقترح موضوعاً» → plan → «صُغها» on a new topic creates a plan idea and drafts it', () =>
  withBot({}, async (bot) => {
    await bot.press('plan');
    const plan = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('💡 اقتراحات للنشر')), 10_000, 'plan');
    assert.match(plan.body.text, /موضوع جديد \[الحوكمة\]\nالزاوية: زاوية جديدة عن اللجان/);
    await bot.press(plan.body.reply_markup.inline_keyboard[0][0].callback_data);
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📝 مسودة #1 — المحور: الحوكمة')), 15_000, 'draft from plan');
    const idea = await bot.row('SELECT text, source, pillar, status FROM ideas WHERE id = 1');
    assert.deepEqual({ ...idea }, { text: 'زاوية جديدة عن اللجان', source: 'plan', pillar: 'الحوكمة', status: 'drafted' });
  }));

test('cron failure is reported to the owner as «⚠️ فشلت مهمة …» and the invocation fails', () =>
  withBot({}, async (bot) => {
    await bot.db
      .prepare(`INSERT INTO drafts (x_segments, linkedin_text, status, socialapi_post_id) VALUES ('["t"]', 'l', 'publishing', 'p_1')`)
      .run();
    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('last_published_at', datetime('now'))").run();
    bot.mocks.getPost = () => ({ status: 401, json: { error: { code: 'auth.invalid_key', message: 'bad key' } } });
    const result = await bot.scheduled('0 6 * * *');
    const msg = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('⚠️ فشلت مهمة المتابعة اليومية')), 5000, 'failure notice');
    assert.match(msg, /مفتاح SocialAPI غير صالح/);
    assert.equal(result.outcome, 'exception');
  }));

test('anthropic response truncated at max_tokens counts as a parse failure and is retried once', () =>
  withBot({}, async (bot) => {
    await bot.sendText('فكرة');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة')), 10_000);
    bot.mocks.anthropic.push(() => ({ status: 200, json: anthropicMessage({ partial: true }, 'max_tokens') }));
    await bot.press(bot.button('صُغها الآن'));
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📝 مسودة #1')), 15_000, 'preview after retry');
    assert.equal(bot.anthropic('draft').length, 2);
  }));

test('claimDraft is atomic on real D1: of two concurrent claims exactly one wins', () =>
  withBot({}, async (bot) => {
    const { claimDraft } = await import('../../src/db.ts');
    await bot.db.prepare(`INSERT INTO drafts (x_segments, linkedin_text) VALUES ('["t"]', 'l')`).run();
    const results = await Promise.all([
      claimDraft(bot.db, 1, ['pending'], 'publishing', 0),
      claimDraft(bot.db, 1, ['pending'], 'publishing', 0),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await claimDraft(bot.db, 1, ['pending'], 'publishing', 1), false, 'stale revision is refused');
  }));

test('if Telegram fails after the post was created, the post id is kept (never marked failed) for the daily follow-up', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    await makeDraft(bot);
    await bot.press(bot.button('✅ انشر الآن'));
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('تأكيد النشر')), 10_000);
    // «جارٍ النشر…» ينجح، ثم يتعطل تيليجرام قبل عرض النتيجة
    bot.mocks.tgFail = (method, body) => method === 'editMessageText' && !body.text.startsWith('⏳');
    bot.mocks.getPost = (id) => ({ status: 200, json: { id, status: 'publishing', targets: [] } });
    await bot.press(bot.button('تأكيد'), { messageId: 9000 });
    await bot.waitFor(() => bot.social('POST', '/v1/posts').length, 10_000);
    await bot.settle(1500, 30_000);
    assert.equal(bot.social('POST', '/v1/posts').length, 1);
    const d = await bot.row('SELECT status, socialapi_post_id FROM drafts WHERE id = 1');
    assert.equal(d.status, 'publishing');
    assert.equal(d.socialapi_post_id, 'p_1');
    // المتابعة اليومية تحسم الحالة
    bot.mocks.tgFail = null;
    bot.mocks.getPost = null;
    await bot.scheduled('0 6 * * *');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('✅ نُشرت المسودة #1')), 5000, 'resolved by cron');
    assert.equal((await bot.row('SELECT status FROM drafts WHERE id = 1')).status, 'published');
  }));
