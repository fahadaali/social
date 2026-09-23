// اختبارات طرفية للوصول السريع: اللوحة الثابتة أسفل المحادثة، وقائمة الأوامر في زر «القائمة».

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

const GRID = [
  ['💡 أفكاري', '📋 قائمة الانتظار'],
  ['🗓 اقترح موضوعات', '📊 تقرير الأداء'],
  ['💳 الرصيد', '💾 نسخة احتياطية'],
  ['⏸ أوقف التذكير', '❓ مساعدة'],
];
const gridOf = (call) => call.body.reply_markup.keyboard.map((r) => r.map((b) => b.text));

const replyTo = async (bot, text, prefix) => {
  const before = bot.tg('sendMessage').length;
  await bot.sendText(text);
  return bot.waitFor(
    () => bot.tg('sendMessage').slice(before).find((c) => c.body.text.startsWith(prefix)),
    10_000,
    `reply to ${text}`,
  );
};

test('/start sends the persistent grid and sets a command menu for the owner chat only', () =>
  withBot({}, async (bot) => {
    const welcome = await replyTo(bot, '/start', 'أهلاً بك');
    assert.deepEqual(gridOf(welcome), GRID);
    assert.equal(welcome.body.reply_markup.is_persistent, true);
    assert.match(welcome.body.text, /الأزرار أسفل المحادثة، أو زر «القائمة»/);

    const [menu] = bot.tg('setMyCommands');
    assert.deepEqual(menu.body.scope, { type: 'chat', chat_id: OWNER });
    assert.deepEqual(
      menu.body.commands.map((c) => c.command),
      ['ideas', 'queue', 'plan', 'stats', 'usage', 'export', 'pause', 'resume', 'help'],
    );
  }));

test('a failing setMyCommands does not stop the welcome', () =>
  withBot({}, async (bot) => {
    bot.mocks.tgFail = (method) => method === 'setMyCommands';
    const welcome = await replyTo(bot, '/start', 'أهلاً بك');
    assert.deepEqual(gridOf(welcome), GRID);
  }));

test('grid buttons run their commands and are never saved as ideas', () =>
  withBot({}, async (bot) => {
    await replyTo(bot, '📋 قائمة الانتظار', '📋 لا توجد مسودات معلّقة أو مجدولة');
    await replyTo(bot, '💳 الرصيد', '📊 رصيد SocialAPI');
    await replyTo(bot, '💡 أفكاري', 'لا توجد أفكار جديدة في البنك');
    const help = await replyTo(bot, '❓ مساعدة', 'طريقة العمل');
    assert.deepEqual(gridOf(help), GRID);
    await bot.settle();
    assert.equal((await bot.row('SELECT COUNT(*) AS n FROM ideas')).n, 0);
    assert.equal(bot.anthropic().length, 0, 'no classification call');
  }));

test('the reminder button toggles pause/resume and the grid follows', () =>
  withBot({}, async (bot) => {
    const paused = await replyTo(bot, '⏸ أوقف التذكير', '⏸ أوقفت تذكيرات انقطاع النشر');
    assert.equal(gridOf(paused)[3][0], '▶️ استأنف التذكير');
    assert.equal((await bot.row("SELECT value FROM state WHERE key = 'reminders_paused'")).value, '1');

    const help = await replyTo(bot, '/help', 'طريقة العمل');
    assert.equal(gridOf(help)[3][0], '▶️ استأنف التذكير', '/help shows the current state');

    // بعض التطبيقات ترسل الإيموجي بلا محدِّد الشكل (U+FE0F)
    const resumed = await replyTo(bot, '▶ استأنف التذكير', '▶️ استؤنفت تذكيرات انقطاع النشر');
    assert.equal(gridOf(resumed)[3][0], '⏸ أوقف التذكير');
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'reminders_paused'"), null);
  }));

test('a grid button while waiting for edit notes runs the command and cancels the wait', () =>
  withBot({}, async (bot) => {
    await bot.db.prepare(`INSERT INTO drafts (x_segments, linkedin_text, status) VALUES ('["t"]', 'l', 'pending')`).run();
    await bot.db
      .prepare("INSERT INTO state (key, value) VALUES ('awaiting_edit', ?)")
      .bind(JSON.stringify({ draft_id: 1, at: Date.now() }))
      .run();
    await replyTo(bot, '📋 قائمة الانتظار', '📋 قائمة الانتظار');
    await bot.settle();
    assert.equal(await bot.row("SELECT value FROM state WHERE key = 'awaiting_edit'"), null);
    assert.equal(bot.anthropic().length, 0, 'not treated as edit notes');
    assert.equal((await bot.row('SELECT revision FROM drafts WHERE id = 1')).revision, 0);
  }));
