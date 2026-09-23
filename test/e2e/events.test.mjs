// اختبارات طرفية لاقتراحات الأحداث (NOTES.md القسم 11): بحث الويب في خطة الأحد، ونشرة الأربعاء.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EVENTS, searchContent, searchMessage, startBot } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

const SUNDAY = '0 5 * * 0';
const WEDNESDAY = '0 5 * * 3';
const CMA_URL = 'https://www.cma.gov.sa/news/governance-update';
const CMA_TITLE = 'هيئة السوق المالية تحدّث لائحة حوكمة الشركات';

const planReply = (suggestions) => () => ({ suggestions });
const s = (angle, source = null, why = 'سبب') => ({ idea_id: null, pillar: 'الحوكمة', angle, why_now: why, source });
const sent = (bot, prefix) =>
  bot.waitFor(() => bot.tg('sendMessage').find((c) => c.body.text.startsWith(prefix)), 10_000, prefix);
const required = (call) => call.body.output_config.format.schema.properties.suggestions.items.required;

test('the Sunday plan searches the web first and builds a suggestion on an event, with its source', () =>
  withBot({}, async (bot) => {
    bot.mocks.anthropic.push(
      planReply([
        s('ماذا تعني تعديلات لجان المراجعة لمجالس الإدارات', 1, 'حدّثت هيئة السوق المالية اللائحة في 21 سبتمبر'),
        s('زاوية 2'),
        s('زاوية 3'),
      ]),
    );
    const result = await bot.scheduled(SUNDAY);
    assert.equal(result.outcome, 'ok');

    const [search] = bot.anthropic('events');
    assert.deepEqual(search.body.tools, [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 5,
        user_location: { type: 'approximate', country: 'SA', timezone: 'Asia/Riyadh' },
      },
    ]);
    assert.deepEqual(search.body.thinking, { type: 'adaptive' });
    assert.deepEqual(search.body.output_config, { effort: 'medium' }, 'no JSON schema: citations do not mix with it');
    assert.match(search.body.system, /أخبار المحاور:[\s\S]*الرائج العام:/);
    assert.match(search.body.messages[0].content, /^اليوم: .+\. ابحث عن أحداث الفترة من .+ حتى اليوم\.$/);

    const [plan] = bot.anthropic('plan');
    const prompt = plan.body.messages[0].content;
    assert.match(prompt, /<events>\n- هيئة السوق المالية تحدّث[^\n]*\[1\]\n- الرائج: انطلاق موسم الرياض[^\n]*\[2\]\n<\/events>/);
    assert.ok(prompt.includes(`[1] ${CMA_TITLE} — ${CMA_URL}`));
    assert.doesNotMatch(prompt, /سأبحث/, 'text before the search is not part of the digest');
    assert.ok(required(plan).includes('source'));

    const msg = await sent(bot, '📅 خطة الأسبوع');
    assert.ok(
      msg.body.text.includes(
        `1) موضوع جديد [الحوكمة]\nالزاوية: ماذا تعني تعديلات لجان المراجعة لمجالس الإدارات\nلماذا الآن: حدّثت هيئة السوق المالية اللائحة في 21 سبتمبر\nالمصدر: ${CMA_TITLE} — ${CMA_URL}`,
      ),
    );
    assert.equal(msg.body.text.split('المصدر:').length - 1, 1, 'only the event-based suggestion has a source');
    assert.doesNotMatch(msg.body.text, /⚠️/);

    await bot.press(bot.button('صُغها (1)'));
    const idea = await bot.waitForRow('SELECT text, source, pillar FROM ideas WHERE id = 1', [], (r) => r.source === 'event', 'event idea');
    assert.equal(
      idea.text,
      `ماذا تعني تعديلات لجان المراجعة لمجالس الإدارات\nالحدث: حدّثت هيئة السوق المالية اللائحة في 21 سبتمبر\nالمصدر: ${CMA_TITLE} — ${CMA_URL}`,
    );
    assert.equal(idea.pillar, 'الحوكمة');
    await bot.waitFor(() => bot.anthropic('draft').length === 1, 10_000, 'draft');
    assert.ok(bot.anthropic('draft')[0].body.messages[0].content.includes(CMA_URL), 'the draft sees the source');

    const recent = JSON.parse((await bot.row("SELECT value FROM state WHERE key = 'recent_events'")).value);
    assert.deepEqual(recent.map((e) => [e.url, e.title]), [[CMA_URL, CMA_TITLE]]);
  }));

test('a failed search does not stop the Sunday plan; the reason is added at the end', () =>
  withBot({}, async (bot) => {
    const down = () => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'x' } } });
    bot.mocks.search.push(down, down);
    const result = await bot.scheduled(SUNDAY);
    assert.equal(result.outcome, 'ok');
    assert.equal(bot.anthropic('events').length, 2, 'retried once');
    const msg = await sent(bot, '📅 خطة الأسبوع');
    assert.match(msg.body.text, /\n\n⚠️ لم أستطع البحث عن أحداث الأسبوع هذه المرة: تعذّر الاتصال بخدمة Claude\.$/);
    const [plan] = bot.anthropic('plan');
    assert.doesNotMatch(plan.body.messages[0].content, /<events>/);
    assert.ok(!required(plan).includes('source'), 'the plain plan schema');
  }));

test('web search disabled in the Anthropic Console is explained, not retried', () =>
  withBot({}, async (bot) => {
    bot.mocks.search.push(() => ({
      status: 400,
      json: { type: 'error', error: { type: 'invalid_request_error', message: 'Web search is not enabled for this organization.' } },
    }));
    await bot.scheduled(SUNDAY);
    const msg = await sent(bot, '📅 خطة الأسبوع');
    assert.match(msg.body.text, /⚠️ لم أستطع البحث عن أحداث الأسبوع هذه المرة: البحث في الويب غير مفعّل في حساب Anthropic\. فعّله من Claude Console ← Settings ← Privacy\.$/);
    assert.equal(bot.anthropic('events').length, 1);
  }));

test('Wednesday digest: event-based suggestions only, suggested events are not repeated, and Sunday buttons still work', () =>
  withBot({}, async (bot) => {
    bot.mocks.anthropic.push(planReply([s('حدث الهيئة', 1), s('زاوية الأحد')]));
    await bot.scheduled(SUNDAY);
    const sunday = await sent(bot, '📅 خطة الأسبوع');
    const sundayPick = sunday.body.reply_markup.inline_keyboard.flat()[1].callback_data;

    bot.mocks.search.push(() => searchMessage(searchContent([DEFAULT_EVENTS[1]])));
    bot.mocks.anthropic.push(planReply([s('بلا حدث'), s('حوكمة الفعاليات الكبرى', 1, 'انطلق موسم الرياض في 20 سبتمبر')]));
    const result = await bot.scheduled(WEDNESDAY);
    assert.equal(result.outcome, 'ok');

    const search = bot.anthropic('events').at(-1);
    assert.ok(search.body.messages[0].content.includes(`<avoid>\n- ${CMA_TITLE}\n</avoid>`), 'Sunday event not repeated');
    const plan = bot.anthropic('plan').at(-1);
    assert.match(plan.body.messages[0].content, /المهمة: اقترح حتى 3 موضوعات للنشر مبنية على أحداث/);

    const wed = await sent(bot, '📰 أحداث منتصف الأسبوع');
    assert.equal(
      wed.body.text,
      '📰 أحداث منتصف الأسبوع — اقتراحات للنشر:\n\n1) موضوع جديد [الحوكمة]\nالزاوية: حوكمة الفعاليات الكبرى\nلماذا الآن: انطلق موسم الرياض في 20 سبتمبر\nالمصدر: انطلاق موسم الرياض — https://example.com/riyadh-season',
    );
    assert.deepEqual(wed.body.reply_markup.inline_keyboard.flat().map((b) => b.text), ['صُغها (1)']);

    const wedPick = wed.body.reply_markup.inline_keyboard.flat()[0].callback_data;
    await bot.press(sundayPick);
    const idea = await bot.waitForRow('SELECT text, source FROM ideas WHERE id = 1', [], (r) => r.source === 'plan', 'Sunday idea');
    assert.equal(idea.text, 'زاوية الأحد');
    await bot.press(wedPick);
    const event = await bot.waitForRow('SELECT text, source FROM ideas WHERE id = 2', [], (r) => r.source === 'event', 'Wednesday idea');
    assert.match(event.text, /^حوكمة الفعاليات الكبرى\nالحدث: انطلق موسم الرياض في 20 سبتمبر\nالمصدر: انطلاق موسم الرياض — https:\/\/example\.com\/riyadh-season$/);
    assert.ok(!bot.texts().some((t) => t.startsWith('هذه الاقتراحات قديمة')));
  }));

test('events suggested more than two weeks ago may come back', () =>
  withBot({}, async (bot) => {
    const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
    await bot.db
      .prepare("INSERT INTO state (key, value) VALUES ('recent_events', ?)")
      .bind(JSON.stringify([
        { url: 'https://new.example/', title: 'حدث حديث', at: at(2) },
        { url: 'https://old.example/', title: 'حدث قديم', at: at(20) },
      ]))
      .run();
    await bot.scheduled(SUNDAY);
    await sent(bot, '📅 خطة الأسبوع');
    const prompt = bot.anthropic('events')[0].body.messages[0].content;
    assert.ok(prompt.includes('<avoid>\n- حدث حديث\n</avoid>'));
  }));

test('Wednesday with nothing notable says so', () =>
  withBot({}, async (bot) => {
    bot.mocks.search.push(() =>
      searchMessage([...searchContent().slice(0, 3), { type: 'text', text: 'لا جديد مهم' }]),
    );
    assert.equal((await bot.scheduled(WEDNESDAY)).outcome, 'ok');
    await sent(bot, '📰 لا أحداث جديدة مهمة منذ الأحد تستحق منشوراً.');
    assert.equal(bot.anthropic('plan').length, 0, 'no plan without events');

    // أحداث موجودة لكن الخطة لم تبنِ عليها شيئاً
    bot.mocks.anthropic.push(planReply([s('بلا حدث')]));
    assert.equal((await bot.scheduled(WEDNESDAY)).outcome, 'ok');
    await bot.waitFor(() => bot.texts().filter((t) => t.startsWith('📰 لا أحداث جديدة')).length === 2, 10_000, 'second note');
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'last_events_plan'"), null);
  }));

test('a failed Wednesday search is reported as a failed task', () =>
  withBot({}, async (bot) => {
    bot.mocks.search.push(() => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'x' } } }));
    const result = await bot.scheduled(WEDNESDAY);
    assert.equal(result.outcome, 'exception');
    await bot.waitFor(
      () => bot.texts().some((t) => t === '⚠️ فشلت مهمة نشرة الأحداث: البحث عن الأحداث: مفتاح Anthropic غير صالح أو لا يملك صلاحية.'),
      10_000,
      'failure notice',
    );
  }));

test('a paused search is resumed by sending the paused answer back unchanged', () =>
  withBot({}, async (bot) => {
    const paused = searchContent().slice(0, 3);
    bot.mocks.search.push(
      () => searchMessage(paused, 'pause_turn'),
      () => searchMessage(searchContent(DEFAULT_EVENTS, { id: 'srvtoolu_2', preface: false })),
    );
    await bot.scheduled(SUNDAY);
    await sent(bot, '📅 خطة الأسبوع');
    const [first, second] = bot.anthropic('events');
    assert.deepEqual(second.body.messages, [first.body.messages[0], { role: 'assistant', content: paused }]);
    const prompt = bot.anthropic('plan')[0].body.messages[0].content;
    assert.match(prompt, /<events>\n- هيئة[^\n]*\[1\]\n- الرائج[^\n]*\[2\]\n<\/events>/);
  }));

test('/plan on demand does not search the web', () =>
  withBot({}, async (bot) => {
    await bot.sendText('/plan');
    await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('💡 اقتراحات للنشر')), 10_000, 'plan');
    assert.equal(bot.anthropic('events').length, 0);
    assert.doesNotMatch(bot.anthropic('plan')[0].body.messages[0].content, /<events>/);
  }));
