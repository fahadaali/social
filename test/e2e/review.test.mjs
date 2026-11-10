// مدقّق الأسلوب بعد الصياغة (src/prompts/review.ts): المراجعة، وإعادة الكتابة بالبنود الساقطة، والسطر في المعاينة.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftOutput, reviewOutput, startBot } from './harness.mjs';

async function withBot(opts, fn) {
  const bot = await startBot(opts);
  try {
    await fn(bot);
  } finally {
    await bot.dispose();
  }
}

/** فكرة ← «صُغها الآن» ← معاينة. drafts: ردود الصياغة بالترتيب (تُضاف بعد التصنيف حتى لا يستهلكها). */
async function formulate(bot, drafts = []) {
  await bot.sendText('الحوكمة في الجمعيات تبدأ من مصفوفة الصلاحيات');
  await bot.waitFor(() => bot.texts().some((t) => t.startsWith('حُفظت الفكرة')), 10_000, 'idea saved');
  bot.mocks.anthropic.push(...drafts);
  await bot.press(bot.button('صُغها الآن'));
  const preview = await bot.waitFor(() => bot.tg('editMessageText').find((c) => c.body.text.startsWith('📝 مسودة')), 20_000, 'preview');
  return preview.body.text;
}

const storedReview = async (bot) => JSON.parse((await bot.row('SELECT style_review AS r FROM drafts WHERE id = 1')).r);

test('a draft that passes the review is shown once with its score', () =>
  withBot({}, async (bot) => {
    const preview = await formulate(bot);
    assert.equal(bot.anthropic('draft').length, 1);
    assert.equal(bot.anthropic('review').length, 1);
    assert.match(preview, /🧭 الأسلوب: 7\/7/);
    const review = bot.anthropic('review')[0].body;
    assert.match(review.system[0].text, /مدقّق أسلوب صارم/);
    assert.match(review.system[0].text, /دليل الأسلوب/);
    assert.match(review.messages[0].content, /1\/ الحوكمة ليست أوراقاً تُحفظ/);
    assert.deepEqual(await storedReview(bot), { passed: 7, total: 7, failed: [] });
  }));

test('failed review items are sent back with their evidence; the better reviewed version is kept', () =>
  withBot({}, async (bot) => {
    bot.mocks.review.push(() => reviewOutput({ practice: 'لا مثال من الممارسة، تعميم فقط', ending: '«وهكذا نرى أن الحوكمة قرار»' }));
    const preview = await formulate(bot, [() => draftOutput(), () => draftOutput({ x_segments: ['رأيت مجلساً وقّع على مصفوفة صلاحيات ولم يقرأها أحد.'] })]);
    const drafts = bot.anthropic('draft');
    assert.equal(drafts.length, 2);
    const fix = drafts[1].body.messages;
    assert.equal(fix[1].role, 'assistant');
    assert.match(fix[2].content, /سقطت في البنود التالية/);
    assert.match(fix[2].content, /- مثال من الممارسة: .*\n {2}ملاحظة المدقّق: لا مثال من الممارسة، تعميم فقط/);
    assert.match(fix[2].content, /خاتمة بلا تلخيص/);
    assert.doesNotMatch(fix[2].content, /موقف واضح/);
    assert.equal(bot.anthropic('review').length, 2);
    assert.match(preview, /رأيت مجلساً وقّع على مصفوفة صلاحيات/);
    assert.match(preview, /🧭 الأسلوب: 7\/7/);
  }));

test('a rewrite that reviews worse is discarded, and the preview names the items still missing', () =>
  withBot({}, async (bot) => {
    bot.mocks.review.push(
      () => reviewOutput({ practice: 'تعميم' }),
      () => reviewOutput({ practice: 'تعميم', stance: 'حياد', voice: 'وعظ' }),
    );
    const preview = await formulate(bot, [() => draftOutput(), () => draftOutput({ x_segments: ['نسخة أسوأ'] })]);
    assert.doesNotMatch(preview, /نسخة أسوأ/);
    assert.match(preview, /1\/ الحوكمة ليست أوراقاً تُحفظ/);
    assert.match(preview, /🧭 الأسلوب: 6\/7، لم يتحقق: مثال من الممارسة/);
    assert.equal((await storedReview(bot)).failed[0].evidence, 'تعميم');
  }));

test('a reviewer outage does not block the draft; it is shown without a score', () =>
  withBot({}, async (bot) => {
    const down = () => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'down' } } });
    bot.mocks.review.push(down, down);
    const preview = await formulate(bot);
    assert.match(preview, /1\/ الحوكمة ليست أوراقاً تُحفظ/);
    assert.doesNotMatch(preview, /🧭/);
    assert.equal((await bot.row('SELECT style_review AS r FROM drafts WHERE id = 1')).r, null);
  }));

test('STYLE_REVIEW=off skips the reviewer', () =>
  withBot({ vars: { STYLE_REVIEW: 'off' } }, async (bot) => {
    const preview = await formulate(bot);
    assert.equal(bot.anthropic('review').length, 0);
    assert.doesNotMatch(preview, /🧭/);
  }));
