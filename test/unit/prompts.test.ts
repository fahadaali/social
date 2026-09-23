import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseClassify, classifySchema } from '../../src/prompts/classify.ts';
import { DRAFT_SCHEMA } from '../../src/prompts/draft.ts';
import { parsePlan, planSchema } from '../../src/prompts/plan.ts';
import {
  isEffectivelyEmpty,
  parsePillars,
  SHARED_RULES,
  stripComments,
  writerSystemPrompt,
} from '../../src/prompts/shared.ts';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('config templates contain only instructions (nothing invented for the owner)', () => {
  assert.equal(isEffectivelyEmpty(read('config/voice.md')), true);
  assert.equal(isEffectivelyEmpty(read('config/pillars.md')), true);
  assert.deepEqual(parsePillars(read('config/pillars.md')), []);
});

test('parsePillars reads level-2 headings, strips descriptions after a colon', () => {
  const md = '<!-- ## ليس محوراً -->\n# محاور\n## الحوكمة\nوصف\n## التخطيط الاستراتيجي: وصف قصير\n### فرعي\n## الحوكمة';
  assert.deepEqual(parsePillars(md), ['الحوكمة', 'التخطيط الاستراتيجي']);
});

test('parsePillars falls back to top-level bullets', () => {
  assert.deepEqual(parsePillars('- القطاع غير الربحي\n- **الامتثال**'), ['القطاع غير الربحي', 'الامتثال']);
});

test('stripComments removes HTML comments', () => {
  assert.equal(stripComments('<!-- x -->\n\n\n# عنوان'), '# عنوان');
});

test('writer system prompt embeds the shared rules and marks an unfilled voice guide', () => {
  const s = writerSystemPrompt(read('config/voice.md'), read('config/pillars.md'));
  assert.ok(s.includes(SHARED_RULES));
  assert.match(s, /لم يُعبّأ بعد/);
  const filled = writerSystemPrompt('## النبرة\nمباشرة وهادئة', '## الحوكمة');
  assert.match(filled, /<voice>[\s\S]*مباشرة وهادئة[\s\S]*<\/voice>/);
});

test('every object in the JSON schemas forbids additional properties (structured outputs)', () => {
  const check = (schema: unknown): void => {
    if (!schema || typeof schema !== 'object') return;
    const s = schema as Record<string, unknown>;
    if (s.type === 'object') assert.equal(s.additionalProperties, false);
    for (const v of Object.values(s)) {
      if (Array.isArray(v)) v.forEach(check);
      else check(v);
    }
  };
  check(DRAFT_SCHEMA);
  check(classifySchema(['أ']));
  check(planSchema([]));
  check(planSchema([], true));
});

test('parseClassify enforces the pillar list and trims long summaries', () => {
  const parse = parseClassify(['الحوكمة']);
  assert.deepEqual(parse({ pillar: 'الحوكمة', summary: 'ملخص قصير' }), { pillar: 'الحوكمة', summary: 'ملخص قصير' });
  assert.equal(parse({ pillar: 'أخرى', summary: 'x' }).pillar, 'أخرى');
  assert.throws(() => parse({ pillar: 'محور مختلق', summary: 'x' }));
  const long = Array.from({ length: 20 }, (_, i) => `كلمة${i}`).join(' ');
  assert.equal(parse({ pillar: 'الحوكمة', summary: long }).summary.split(' ').length, 15);
});

test('parsePlan keeps at most 3, maps unknown ids to new topics and skips duplicates', () => {
  const parse = parsePlan(new Set([1, 2]));
  const out = parse({
    suggestions: [
      { idea_id: 1, pillar: 'أ', angle: 'زاوية 1', why_now: 'لأن' },
      { idea_id: 1, pillar: 'أ', angle: 'مكررة', why_now: '' },
      { idea_id: 99, pillar: 'ب', angle: 'جديد', why_now: '' },
      { idea_id: 2, pillar: 'ج', angle: 'زاوية 2', why_now: '' },
      { idea_id: null, pillar: 'د', angle: 'زائد', why_now: '' },
    ],
  });
  assert.deepEqual(out.map((s) => [s.idea_id, s.angle]), [[1, 'زاوية 1'], [null, 'جديد'], [2, 'زاوية 2']]);
  assert.throws(() => parse({ suggestions: [] }));
});
