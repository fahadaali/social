// اختبارات طرفية للمرحلتين 2 و3 (SPEC §12): /queue و/usage و/pause و/resume والخطة الأسبوعية،
// و/stats والتقرير الأسبوعي واستخدام المقاييس في الخطة.

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

/** منشورات منشورة مباشرة في D1: [{pillar, daysAgo, status}] */
async function seedPublished(bot, posts) {
  let n = 0;
  for (const p of posts) {
    n++;
    await bot.db
      .prepare("INSERT INTO ideas (text, pillar, status) VALUES (?, ?, 'published')")
      .bind(`فكرة ${n}`, p.pillar ?? 'الحوكمة')
      .run();
    await bot.db
      .prepare(
        `INSERT INTO drafts (idea_id, x_segments, linkedin_text, status, socialapi_post_id, published_at)
         VALUES (?, ?, 'نص لينكدن', ?, ?, datetime('now', ?))`,
      )
      .bind(n, JSON.stringify([`تغريدة المنشور ${n}`]), p.status ?? 'published', `p_${n}`, `-${p.daysAgo ?? 1} days`)
      .run();
  }
}

async function seedDraft(bot, status, extra = {}) {
  const r = await bot.db
    .prepare(
      `INSERT INTO drafts (x_segments, linkedin_text, status, scheduled_at, telegram_message_id)
       VALUES (?, 'نص', ?, ?, ?) RETURNING id`,
    )
    .bind(JSON.stringify([extra.tweet ?? `تغريدة ${status}`]), status, extra.scheduledAt ?? null, extra.messageId ?? null)
    .first();
  return r.id;
}

const commandReply = async (bot, command, prefix) => {
  await bot.sendText(command);
  return bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith(prefix)), 10_000, `${command} reply`);
};

// ---------- المرحلة 2 ----------

test('/help lists every command and the automatic schedule', () =>
  withBot({}, async (bot) => {
    const msg = await commandReply(bot, '/help', 'طريقة العمل');
    for (const c of ['/ideas', '/plan', '/queue', '/stats', '/usage', '/pause', '/resume', '/help']) {
      assert.ok(msg.body.text.includes(c), c);
    }
    assert.match(msg.body.text, /خطة أسبوعية الأحد 8 ص، وتقرير أداء الخميس 5 م/);
  }));

test('/queue groups scheduled, pending/failed and publishing drafts; «عرض» for each resends a preview with its buttons', () =>
  withBot({}, async (bot) => {
    const pending = await seedDraft(bot, 'pending', { messageId: 4242 });
    await seedDraft(bot, 'failed');
    await seedDraft(bot, 'scheduled', { scheduledAt: '2030-01-02 17:00:00' });
    await seedDraft(bot, 'publishing');
    await seedDraft(bot, 'published');
    const msg = await commandReply(bot, '/queue', '📋 قائمة الانتظار');
    assert.match(msg.body.text, /🕒 المجدولة \(1\):\n• #3 — الأربعاء 2 يناير، 8:00 م — «تغريدة scheduled»/);
    assert.match(msg.body.text, /📝 المعلّقة \(الأحدث أولاً\):\n• #2 \(نسخة 1\) ⚠️ فشل نشرها — «تغريدة failed»\n• #1 \(نسخة 1\) — «تغريدة pending»/);
    assert.match(msg.body.text, /⏳ قيد النشر:\n• #4/);
    assert.ok(!msg.body.text.includes('#5'), 'published drafts are not queued');
    // بترتيب الأقسام: المجدولة ثم المعلّقة ثم قيد النشر
    assert.deepEqual(msg.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['shw:3', 'shw:2', 'shw:1', 'shw:4']);

    await bot.press(`shw:${pending}`);
    const preview = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('📝 مسودة #1')), 10_000, 'preview');
    assert.ok(preview.body.reply_markup.inline_keyboard.flat().some((b) => b.text === '✅ انشر الآن'));
    await bot.settle();
    assert.ok(bot.tg('editMessageReplyMarkup').some((c) => c.body.message_id === 4242), 'old preview buttons cleared');
  }));

test('/queue with nothing waiting', () =>
  withBot({}, async (bot) => {
    await commandReply(bot, '/queue', '📋 لا توجد مسودات معلّقة أو مجدولة');
  }));

test('/usage shows used/limit/remaining, the renewal date, and the DRY_RUN note', () =>
  withBot({}, async (bot) => {
    const msg = await commandReply(bot, '/usage', '📊 رصيد SocialAPI');
    assert.match(msg.body.text, /المنشورات: استُخدم 4 من 10 — المتبقي 6/);
    assert.match(msg.body.text, /يتجدد الرصيد: الخميس 15 أكتوبر، 3:00 ص/);
    assert.match(msg.body.text, /وضع التجربة مفعّل/);
  }));

test('/usage handles unlimited plans and low credit', () =>
  withBot({ vars: { DRY_RUN: 'false' } }, async (bot) => {
    bot.mocks.usage = { posts_used: 120, posts_limit: -1 };
    let msg = await commandReply(bot, '/usage', '📊');
    assert.match(msg.body.text, /غير محدود \(استُخدم 120\)/);
    assert.doesNotMatch(msg.body.text, /وضع التجربة/);
    bot.mocks.usage = { posts_used: 9, posts_limit: 10 };
    await bot.sendText('/usage');
    msg = await bot.waitFor(() => bot.tg('sendMessage').filter((c) => c.body.text.startsWith('📊')).at(1), 10_000);
    assert.match(msg.body.text, /المتبقي 1\n⚠️ الرصيد يوشك على النفاد/);
  }));

test('/usage reports a SocialAPI error without technical details', () =>
  withBot({}, async (bot) => {
    bot.mocks.usageError = true;
    await bot.sendText('/usage');
    const msg = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('تعذّر جلب الرصيد')), 10_000);
    assert.equal(msg, 'تعذّر جلب الرصيد: مفتاح SocialAPI غير صالح أو منتهٍ. حدّثه عبر wrangler secret put SOCIALAPI_KEY.');
  }));

test('/pause stops the daily reminder and /resume brings it back', () =>
  withBot({}, async (bot) => {
    await bot.db.prepare("INSERT INTO state (key, value) VALUES ('last_published_at', datetime('now', '-6 days'))").run();
    await commandReply(bot, '/pause', '⏸ أوقفت تذكيرات انقطاع النشر');
    assert.equal((await bot.row("SELECT value FROM state WHERE key = 'reminders_paused'")).value, '1');
    await bot.scheduled('0 6 * * *');
    await bot.settle();
    assert.ok(!bot.texts().some((t) => t.startsWith('⏰')), 'no reminder while paused');

    await commandReply(bot, '/resume', '▶️ استؤنفت');
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'reminders_paused'"), null);
    await bot.scheduled('0 6 * * *');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('⏰ مرّ 6 أيام')), 5000, 'reminder after resume');
  }));

test('weekly plan cron (Sunday 05:00 UTC) sends 3-topic plan with «صُغها» buttons', () =>
  withBot({}, async (bot) => {
    bot.mocks.anthropic.push(() => ({
      suggestions: [
        { idea_id: null, pillar: 'الحوكمة', angle: 'زاوية 1', why_now: 'سبب 1' },
        { idea_id: null, pillar: 'التخطيط', angle: 'زاوية 2', why_now: 'سبب 2' },
        { idea_id: null, pillar: 'الامتثال', angle: 'زاوية 3', why_now: 'سبب 3' },
      ],
    }));
    const result = await bot.scheduled('0 5 * * 0');
    assert.equal(result.outcome, 'ok');
    const msg = await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('📅 خطة الأسبوع')), 5000, 'plan');
    assert.match(msg.body.text, /1\) موضوع جديد \[الحوكمة\]\nالزاوية: زاوية 1\nلماذا الآن: سبب 1/);
    assert.deepEqual(msg.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ['صُغها (1)', 'صُغها (2)', 'صُغها (3)']);
    assert.equal(bot.tg('sendMessage').filter((c) => c.body.text.startsWith('⏳')).length, 0, 'no placeholder in cron');
  }));

test('weekly plan cron failure is reported as «⚠️ فشلت مهمة الخطة الأسبوعية»', () =>
  withBot({}, async (bot) => {
    const bad = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'x' } } });
    bot.mocks.anthropic.push(bad);
    const result = await bot.scheduled('0 5 * * 0');
    assert.equal(result.outcome, 'exception');
    const msg = await bot.waitFor(() => bot.texts().find((t) => t.startsWith('⚠️ فشلت مهمة الخطة الأسبوعية')), 5000);
    assert.match(msg, /مفتاح Anthropic غير صالح/);
  }));

// ---------- المرحلة 3 ----------

test('/stats: metrics of the last 30 days → report with the four fields, data line and low-data note', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 2 }, { daysAgo: 10, pillar: 'التخطيط' }, { daysAgo: 45 }]);
    await bot.sendText('/stats');
    const done = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📈 تقرير الأداء')), 15_000, 'report');
    const text = done.body.text;
    assert.match(text, /أسبوع هادئ بتفاعل محدود/);
    assert.match(text, /🏆 المنشور #1 تصدّر/);
    assert.match(text, /💡 /);
    assert.match(text, /➡️ للأسبوع القادم: /);
    assert.match(text, /— البيانات: منشوران، منها 2 بمقاييس متاحة/);
    assert.match(text, /ℹ️ البيانات قليلة، فالاستنتاجات مبدئية/);
    // المنشور الأقدم من 30 يوماً خارج التقرير
    assert.deepEqual(bot.social('GET').filter((c) => c.path.endsWith('/metrics')).map((c) => c.path).sort(), ['/v1/posts/p_1/metrics', '/v1/posts/p_2/metrics']);
    const [report] = bot.anthropic('report');
    const prompt = report.body.messages[0].content;
    assert.match(prompt, /X: إعجابات 12، تعليقات 3، مشاركات 2، حفظ 1 \| لينكدن: إعجابات غير متوفر/);
    assert.match(prompt, /المجموع: 18/);
    assert.match(prompt, /البيانات قليلة/);
    assert.equal(report.body.model, 'claude-sonnet-5');
    // حُفظت لقطة المقاييس للخطة
    const snap = JSON.parse((await bot.row("SELECT value FROM state WHERE key = 'metrics_snapshot'")).value);
    assert.deepEqual(snap.items.map((i) => [i.draft_id, i.total]), [[1, 18], [2, 18]]);
  }));

test('/stats with nothing published: explicit no-data message and no Claude call', () =>
  withBot({}, async (bot) => {
    await bot.sendText('/stats');
    const done = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📈')), 10_000);
    assert.match(done.body.text, /لم يُنشر شيء عبر البوت خلال هذه الفترة، فلا أرقام يُبنى عليها تقرير/);
    assert.equal(bot.anthropic().length, 0);
  }));

test('/stats when platforms return no numbers: says so instead of inferring', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 1 }]);
    bot.mocks.metrics = (id) => ({ status: 200, json: { data: { post_id: id, targets: [{ platform: 'linkedin', status: 'published' }] } } });
    await bot.sendText('/stats');
    const done = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📈')), 10_000);
    assert.match(done.body.text, /نُشر منشور واحد خلال الفترة، لكن SocialAPI لم تُرجع لها مقاييس بعد، فلا أستنتج شيئاً/);
    assert.equal(bot.anthropic().length, 0);
  }));

test('/stats surfaces a metrics failure with «أعد المحاولة»; one failing post does not sink the report', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 1 }, { daysAgo: 2 }]);
    bot.mocks.metrics = () => ({ status: 401, json: { error: { code: 'auth.invalid_key', message: 'bad' } } });
    await bot.sendText('/stats');
    const failed = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('❌ تعذّر إعداد التقرير')), 10_000);
    assert.match(failed.body.text, /مفتاح SocialAPI غير صالح/);
    assert.equal(failed.body.reply_markup.inline_keyboard[0][0].callback_data, 'rt:s:0');

    bot.mocks.metrics = (id) =>
      id === 'p_2'
        ? { status: 502, json: { error: { code: 'platform.twitter.api_error', message: 'x' } } }
        : { status: 200, json: { data: { post_id: id, targets: [{ platform: 'twitter', status: 'published', metrics: { likes: 5 } }] } } };
    await bot.press('rt:s:0');
    const ok = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📈')), 15_000, 'report after retry');
    assert.match(ok.body.text, /منشوران، منها 1 بمقاييس متاحة/);
    assert.match(bot.anthropic('report')[0].body.messages[0].content, /#2 .*تعذّر جلب المقاييس/);
  }));

test('weekly report cron (Thursday 14:00 UTC) sends the report; a failure is reported to the owner', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 3 }]);
    const ok = await bot.scheduled('0 14 * * 4');
    assert.equal(ok.outcome, 'ok');
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('📈 تقرير الأداء')), 5000, 'report');

    bot.mocks.metrics = () => ({ status: 401, json: { error: { code: 'auth.invalid_key', message: 'bad' } } });
    const bad = await bot.scheduled('0 14 * * 4');
    assert.equal(bad.outcome, 'exception');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('⚠️ فشلت مهمة تقرير الأداء الأسبوعي: مفتاح SocialAPI غير صالح')), 5000);
  }));

test('the plan uses the latest metrics snapshot (pillar performance) to weigh suggestions', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 1 }, { daysAgo: 2, pillar: 'التخطيط' }, { daysAgo: 3 }]);
    await bot.sendText('/stats');
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📈')), 15_000);
    const metricCalls = bot.social('GET').filter((c) => c.path.endsWith('/metrics')).length;
    await bot.sendText('/plan');
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('💡 اقتراحات للنشر')), 15_000);
    const prompt = bot.anthropic('plan')[0].body.messages[0].content;
    assert.match(prompt, /<performance>[\s\S]*- الحوكمة: منشوران، متوسط التفاعل 18[\s\S]*- التخطيط: منشور واحد، متوسط التفاعل 18[\s\S]*رجّح المحاور/);
    assert.equal(bot.social('GET').filter((c) => c.path.endsWith('/metrics')).length, metricCalls, '/plan reuses the snapshot');
  }));

test('the Sunday plan refreshes a missing/old snapshot first, and still plans if metrics fail', () =>
  withBot({}, async (bot) => {
    await seedPublished(bot, [{ daysAgo: 1 }]);
    await bot.scheduled('0 5 * * 0');
    await bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith('📅 خطة الأسبوع')), 5000);
    assert.equal(bot.social('GET').filter((c) => c.path.endsWith('/metrics')).length, 1);
    assert.match(bot.anthropic('plan')[0].body.messages[0].content, /<performance>/);

    // لقطة حديثة: لا تحديث. ولقطة قديمة مع فشل المقاييس: الخطة تستمر
    await bot.scheduled('0 5 * * 0');
    await bot.settle();
    assert.equal(bot.social('GET').filter((c) => c.path.endsWith('/metrics')).length, 1, 'fresh snapshot reused');
    await bot.db.prepare("UPDATE state SET value = json_set(value, '$.at', datetime('now', '-9 days')) WHERE key = 'metrics_snapshot'").run();
    bot.mocks.metrics = () => ({ status: 500, json: { error: { code: 'system.internal', message: 'x' } } });
    const r = await bot.scheduled('0 5 * * 0');
    assert.equal(r.outcome, 'ok');
    assert.equal(bot.tg('sendMessage').filter((c) => c.body.text.startsWith('📅 خطة الأسبوع')).length, 3);
  }));

// ---------- الرسائل الصوتية (المرحلة 2، بعد موافقة المالك) ----------

test('voice note → Whisper (Arabic) → idea with source voice, classified, transcript shown for checking', () =>
  withBot({}, async (bot) => {
    await bot.sendVoice({ duration: 40 });
    const saved = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('حُفظت الفكرة #1')), 10_000, 'voice idea');
    assert.ok(bot.tg('sendMessage').some((c) => c.body.text.startsWith('🎙 أفرّغ الرسالة الصوتية')), 'progress message first');
    assert.match(saved.body.text, /🎙 النص المفرّغ:\n«فكرة صوتية: مجالس الإدارة تحتاج مصفوفة صلاحيات واضحة»/);
    assert.deepEqual(saved.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ['صُغها الآن']);
    const [call] = bot.ai();
    assert.equal(call.body.model, '@cf/openai/whisper-large-v3-turbo');
    assert.equal(call.body.inputs.language, 'ar');
    assert.equal(call.body.inputs.task, 'transcribe');
    assert.equal(call.body.inputs.vad_filter, true);
    assert.equal(call.body.inputs.audio.base64, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64'));
    assert.equal(bot.lastTg('getFile').body.file_id, 'voice_1');
    const idea = await bot.row('SELECT text, source, pillar FROM ideas WHERE id = 1');
    assert.deepEqual({ ...idea }, { text: 'فكرة صوتية: مجالس الإدارة تحتاج مصفوفة صلاحيات واضحة', source: 'voice', pillar: 'الحوكمة' });
  }));

test('audio files are transcribed too; over-long notes are refused before any download', () =>
  withBot({}, async (bot) => {
    await bot.sendVoice({ asAudio: true });
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة #1')), 10_000);
    await bot.sendVoice({ duration: 301 });
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('الرسالة الصوتية أطول من 5 دقائق')), 5000);
    assert.equal(bot.ai().length, 1);
    assert.equal(bot.tg('getFile').length, 1);
  }));

test('silence / no speech → clear message and nothing saved', () =>
  withBot({}, async (bot) => {
    bot.mocks.ai = () => ({ text: '   ' });
    await bot.sendVoice();
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('لم أتعرّف على كلام')), 10_000);
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 0);
    assert.equal(bot.anthropic().length, 0);
  }));

test('transcription failure → «أعد المحاولة» retries the same voice note', () =>
  withBot({}, async (bot) => {
    bot.mocks.ai = () => ({ __error: 'AiError: inference failed' });
    await bot.sendVoice();
    const failed = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('❌ تعذّر تفريغ الرسالة الصوتية')), 10_000);
    assert.equal(failed.body.reply_markup.inline_keyboard[0][0].callback_data, 'rt:v:0');
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 0);
    bot.mocks.ai = null;
    await bot.press('rt:v:0');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة #1')), 10_000, 'saved after retry');
    assert.equal(bot.tg('getFile').filter((c) => c.body.file_id === 'voice_1').length, 2);
  }));

test('daily Workers AI allocation exhausted → specific message', () =>
  withBot({}, async (bot) => {
    bot.mocks.ai = () => ({ __error: 'AiError: you have used up your daily free allocation of 10,000 neurons' });
    await bot.sendVoice();
    await bot.waitFor(() => bot.texts().some((t) => t.includes('استُنفدت حصة Workers AI اليومية')), 10_000);
  }));

test('a voice note while waiting for edit notes becomes an idea and cancels the wait', () =>
  withBot({}, async (bot) => {
    await bot.db.prepare(`INSERT INTO drafts (x_segments, linkedin_text) VALUES ('["t"]', 'l')`).run();
    await bot.press('edt:1');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('✏️ اكتب ملاحظاتك')), 5000);
    await bot.sendVoice();
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة #1')), 10_000);
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'awaiting_edit'"), null);
    assert.equal(bot.anthropic('draft').length, 0, 'not treated as revision notes');
  }));
