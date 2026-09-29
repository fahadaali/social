// اختبارات طرفية لمواعيد المهام المجدولة بصيغة Cloudflare (NOTES.md القسم 2.13).

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

const plain = (html) => html.replace(/<[^>]+>/g, '');
const setupText = async (bot) => plain((await bot.get('/setup')).text);

test('the numeric weekday form Cloudflare may pass back still runs the Sunday plan', () =>
  withBot({}, async (bot) => {
    const result = await bot.scheduled('0 5 * * 1');
    assert.equal(result.outcome, 'ok');
    await bot.waitFor(() => bot.texts().some((t) => t.startsWith('📅 خطة الأسبوع')), 10_000, 'plan');
  }));

test('an unknown schedule is reported to the owner instead of passing silently', () =>
  withBot({}, async (bot) => {
    const result = await bot.scheduled('0 5 * * 0');
    assert.equal(result.outcome, 'ok');
    await bot.waitFor(
      () => bot.texts().some((t) => t === '⚠️ وصل موعد مجدول غير معروف (0 5 * * 0). راجع [triggers] في wrangler.toml.'),
      10_000,
      'notice',
    );
    assert.ok(!bot.texts().some((t) => t.startsWith('📅')));
  }));

test('/setup shows whether the scheduled tasks run', () =>
  withBot({}, async (bot) => {
    let text = await setupText(bot);
    assert.match(text, /ℹ️ لم تعمل أي مهمة مجدولة بعد، وأولها يومياً 9 ص/);
    assert.match(text, /كل شيء جاهز/, 'not a problem on the first day');

    await bot.scheduled('0 6 * * *');
    text = await setupText(bot);
    assert.match(text, /✅ المهام المجدولة تعمل، وآخرها في /);

    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await bot.db.prepare("UPDATE state SET value = ? WHERE key = 'last_cron_at'").bind(old).run();
    text = await setupText(bot);
    assert.match(text, /❌ آخر مهمة مجدولة عملت في .+، ولم تعمل بعدها: راجع Settings ← Trigger Events في الـ Worker/);
    assert.match(text, /أكمل ما عليه ❌/);
  }));
