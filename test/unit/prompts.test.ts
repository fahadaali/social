import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseClassify, classifySchema } from '../../src/prompts/classify.ts';
import { DRAFT_SCHEMA } from '../../src/prompts/draft.ts';
import { reviseUser } from '../../src/prompts/revise.ts';
import { parseReview, REVIEW_CRITERIA, REVIEW_SCHEMA, reviewFixTurn, reviewLine } from '../../src/prompts/review.ts';
import { parsePlan, planSchema } from '../../src/prompts/plan.ts';
import {
  isEffectivelyEmpty,
  parsePillars,
  SHARED_RULES,
  stripComments,
  writerSystemPrompt,
} from '../../src/prompts/shared.ts';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('config files: voice guide is filled; pillars parse from headings only, never from the template comment', () => {
  assert.equal(isEffectivelyEmpty(read('config/voice.md')), false);
  const pillars = read('config/pillars.md');
  const names = parsePillars(pillars);
  assert.ok(!names.includes('اسم المحور'), 'the example inside the template comment is not a pillar');
  assert.equal(names.length === 0, isEffectivelyEmpty(pillars), 'pillar names exist exactly when the file is filled');
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
  const s = writerSystemPrompt('<!-- قالب -->\n# دليل الأسلوب\n## النبرة والأسلوب', read('config/pillars.md'));
  assert.ok(s.includes(SHARED_RULES));
  assert.match(s, /لم يُعبّأ بعد/);
  const real = writerSystemPrompt(read('config/voice.md'), read('config/pillars.md'));
  assert.match(real, /<voice>[\s\S]*## المرجعيات[\s\S]*<\/voice>/);
  assert.doesNotMatch(real, /لا يعدّل Claude Code/);
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

test('reviseUser asks for a visible change, covers all platforms, and lists earlier notes', () => {
  const current = { x_segments: ['أ'], linkedin_text: 'ب', snap_script: ['ج'], needs_visual: false, visual_brief: null, notes: null };
  const first = reviseUser(null, current, 'الصياغة تبدو آلية');
  assert.match(first, /إعادة المسودة كما هي، أو بتبديل كلمة بمرادفها، خطأ/);
  assert.match(first, /فأعد كتابة كل جملة بعبارة جديدة/);
  assert.match(first, /فهي تنطبق على X ولينكدن وسناب جميعاً/);
  assert.doesNotMatch(first, /<previous_notes>/);
  const third = reviseUser(null, current, 'غيّرها', ['الصياغة تبدو آلية', 'ما تغيّر شيء']);
  assert.match(third, /<previous_notes>\n1\. الصياغة تبدو آلية\n2\. ما تغيّر شيء\n<\/previous_notes>/);
  assert.ok(third.indexOf('<previous_notes>') < third.indexOf('<owner_notes>'));
});

test('review schema asks for every criterion; parseReview keeps the failed ones in order', () => {
  const props = (REVIEW_SCHEMA.properties as { checks: { required: string[] } }).checks.required;
  assert.deepEqual(props, REVIEW_CRITERIA.map((c) => c.id));
  const checks = Object.fromEntries(REVIEW_CRITERIA.map((c) => [c.id, { pass: c.id !== 'ending' && c.id !== 'practice', evidence: ` ${c.id} ` }]));
  const r = parseReview({ checks });
  assert.equal(r.passed, REVIEW_CRITERIA.length - 2);
  assert.deepEqual(r.failed.map((f) => f.id), ['practice', 'ending']);
  assert.equal(r.failed[0]?.evidence, 'practice');
  assert.equal(reviewLine(r), `🧭 الأسلوب: ${r.passed}/${r.total}، لم يتحقق: مثال من الممارسة، خاتمة بلا تلخيص`);
  assert.throws(() => parseReview({ checks: { stance: { pass: true, evidence: '' } } }), /missing/);
});

test('reviewFixTurn replays the draft and lists only the failed items with the reviewer notes', () => {
  const draft = { x_segments: ['أ'], linkedin_text: 'ب', snap_script: ['ج'], needs_visual: false, visual_brief: null, notes: null };
  const [assistant, user] = reviewFixTurn(draft, {
    passed: 6,
    total: 7,
    failed: [{ id: 'opening', label: 'افتتاحية مباشرة', pass: false, evidence: '«هل تساءلت يوماً»' }],
  });
  assert.equal(assistant?.content, JSON.stringify(draft));
  assert.match(user?.content ?? '', /- افتتاحية مباشرة: .*\n {2}ملاحظة المدقّق: «هل تساءلت يوماً»/);
  assert.match(user?.content ?? '', /لا تختلق مثالاً فيه رقم أو جهة/);
});

test('the evaluation set parses into ten ideas with their pillars', async () => {
  const { parseIdeas } = await import('../../scripts/style-eval.ts');
  const ideas = parseIdeas(read('eval/ideas.md'));
  assert.equal(ideas.length, 10);
  assert.deepEqual(ideas[0], {
    id: '1',
    pillar: 'الحوكمة',
    text: 'أغلب مجالس إدارات الجمعيات توافق على الميزانية في اجتماع واحد بلا نقاش حقيقي، لأن الأعضاء يستلمونها قبل الاجتماع بيوم.',
  });
  assert.deepEqual(parseIdeas('## 1\nفكرة بلا محور'), [{ id: '1', pillar: null, text: 'فكرة بلا محور' }]);
});
