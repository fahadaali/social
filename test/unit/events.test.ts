import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDigest, EVENTS_MAX_SOURCES, eventsSystem, eventsUser, type ResponseBlock } from '../../src/prompts/events.ts';
import { parsePlan, planSchema, planUser } from '../../src/prompts/plan.ts';
import { OWNER_PROFILE } from '../../src/prompts/shared.ts';

const cite = (url: string, title = 'عنوان') => ({ type: 'web_search_result_location', url, title });

test('buildDigest numbers the cited sources of the final answer only, without duplicates', () => {
  const blocks: ResponseBlock[] = [
    { type: 'text', text: 'سأبحث الآن.', citations: [cite('https://early.example/x')] },
    { type: 'server_tool_use' },
    { type: 'web_search_tool_result' },
    { type: 'text', text: '- حدث أول (21 سبتمبر)\n', citations: [cite('https://a.example/1', 'مصدر أ')] },
    { type: 'text', text: '- حدث ثانٍ', citations: [cite('https://b.example/2', 'مصدر ب'), cite('https://a.example/1', 'مصدر أ')] },
    { type: 'text', text: ' وتعليق بلا مصدر.' },
  ];
  assert.deepEqual(buildDigest(blocks), {
    text: '- حدث أول (21 سبتمبر) [1]\n- حدث ثانٍ [2][1] وتعليق بلا مصدر.',
    sources: [
      { url: 'https://a.example/1', title: 'مصدر أ' },
      { url: 'https://b.example/2', title: 'مصدر ب' },
    ],
  });
});

test('buildDigest keeps only real search links, cleans titles and caps the list', () => {
  const many = Array.from({ length: EVENTS_MAX_SOURCES + 3 }, (_, i) => cite(`https://s${i}.example/`));
  const digest = buildDigest([
    {
      type: 'text',
      text: '- أحداث',
      citations: [
        { type: 'char_location', url: 'https://doc.example/' },
        cite('javascript:alert(1)'),
        cite(`https://long.example/${'x'.repeat(400)}`),
        cite('https://www.titleless.example/p', '  '),
        cite('https://spaces.example/', 'عنوان\n  على   سطرين'),
        ...many,
      ],
    },
  ]);
  assert.ok(digest);
  assert.equal(digest.sources.length, EVENTS_MAX_SOURCES);
  assert.deepEqual(digest.sources[0], { url: 'https://www.titleless.example/p', title: 'titleless.example' });
  assert.equal(digest.sources[1]?.title, 'عنوان على سطرين');
  assert.ok(digest.sources.every((s) => s.url.startsWith('https://') && s.url.length < 300));
  assert.ok(!digest.text.includes(`[${EVENTS_MAX_SOURCES + 1}]`));
});

test('buildDigest returns null when nothing is cited (nothing notable)', () => {
  assert.equal(buildDigest([{ type: 'server_tool_use' }, { type: 'text', text: 'لا جديد مهم' }]), null);
  assert.equal(buildDigest([]), null);
  assert.equal(buildDigest([{ type: 'text', text: 'نص', citations: null }]), null);
});

test('events prompt: owner, pillars, both kinds of events, and the avoid list only when needed', () => {
  const system = eventsSystem('## الحوكمة\nمجالس الإدارات');
  assert.ok(system.includes(OWNER_PROFILE));
  assert.match(system, /<pillars>[\s\S]*الحوكمة[\s\S]*<\/pillars>/);
  assert.match(system, /أخبار المحاور:/);
  assert.match(system, /الرائج العام:/);
  assert.match(system, /لا تذكر حدثاً من ذاكرتك/);
  assert.equal(eventsUser('الأحد', 'الاثنين', []), 'اليوم: الأحد. ابحث عن أحداث الفترة من الاثنين حتى اليوم.');
  assert.match(eventsUser('الأحد', 'الاثنين', ['حدث قديم']), /<avoid>\n- حدث قديم\n<\/avoid>/);
});

const digest = {
  text: '- حدث أول [1]\n- حدث ثانٍ [2]',
  sources: [
    { url: 'https://a.example/1', title: 'مصدر أ' },
    { url: 'https://b.example/2', title: 'مصدر ب' },
  ],
};

test('plan prompt with events: numbered sources and at most two event-based suggestions', () => {
  const prompt = planUser('اليوم', [], [], null, { digest, only: false });
  assert.match(prompt, /<events>\n- حدث أول \[1\]\n- حدث ثانٍ \[2\]\n<\/events>/);
  assert.match(prompt, /<sources>\n\[1\] مصدر أ — https:\/\/a\.example\/1\n\[2\] مصدر ب — https:\/\/b\.example\/2\n<\/sources>/);
  assert.match(prompt, /واحد أو اثنان من الاقتراحات على الأكثر مبنيان على أحداث/);
  assert.match(prompt, /- source: رقم المصدر/);
  assert.match(prompt, /إذا قلّت الأفكار/);
  assert.doesNotMatch(planUser('اليوم', [], [], null), /source|<events>/);
});

test('events-only prompt: every suggestion from an event, empty list allowed', () => {
  const prompt = planUser('اليوم', [], [], null, { digest, only: true });
  assert.match(prompt, /المهمة: اقترح حتى 3 موضوعات للنشر مبنية على أحداث/);
  assert.match(prompt, /فأعد قائمة فارغة/);
  assert.doesNotMatch(prompt, /إذا قلّت الأفكار|واحد أو اثنان/);
});

test('plan schema asks for source only with events', () => {
  const items = (s: Record<string, unknown>) =>
    ((s.properties as Record<string, { items: { required: string[]; properties: object } }>).suggestions).items;
  assert.ok(!items(planSchema([])).required.includes('source'));
  assert.ok(items(planSchema([], true)).required.includes('source'));
  assert.ok('source' in items(planSchema([], true)).properties);
});

test('parsePlan maps valid source numbers only; events-only keeps event-based suggestions', () => {
  const s = (source: unknown, angle = 'زاوية') => ({ idea_id: null, pillar: 'أ', angle, why_now: 'لأن', source });
  const parse = parsePlan(new Set(), { sources: digest.sources });
  const out = parse({ suggestions: [s(2, 'أ'), s(0, 'ب'), s(3, 'ج')] });
  assert.deepEqual(out.map((x) => x.source), [digest.sources[1], null, null]);
  assert.deepEqual(parse({ suggestions: [s(1.5), s('1')] }).map((x) => x.source), [null, null]);

  const only = parsePlan(new Set(), { sources: digest.sources, eventsOnly: true });
  assert.deepEqual(only({ suggestions: [s(null, 'بلا حدث'), s(1, 'مع حدث')] }).map((x) => x.angle), ['مع حدث']);
  assert.deepEqual(only({ suggestions: [] }), []);
  assert.throws(() => parse({ suggestions: [] }));
  assert.equal(parsePlan(new Set())({ suggestions: [s(1)] })[0]?.source, null, 'no sources → no links');
});
