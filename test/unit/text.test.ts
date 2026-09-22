import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDraftLimits,
  countWords,
  parseDraftContent,
  ShapeError,
  X_MAX_WEIGHTED,
  xTooLong,
  xWeightedLength,
  type DraftContent,
} from '../../src/text.ts';

test('X weighted length: Latin and Arabic letters weigh 1', () => {
  assert.equal(xWeightedLength('hello'), 5);
  assert.equal(xWeightedLength('الحوكمة'), 7);
  assert.equal(xWeightedLength('الحوكمةُ، والتخطيطُ؟'), 'الحوكمةُ، والتخطيطُ؟'.length);
});

test('X weighted length: URL = 23, emoji = 2, CJK = 2 each', () => {
  assert.equal(xWeightedLength('انظر https://example.com/a/very/long/path?with=query'), 5 + 23);
  assert.equal(xWeightedLength('👍'), 2);
  assert.equal(xWeightedLength('👨‍👩‍👧'), 2);
  assert.equal(xWeightedLength('漢字'), 4);
});

test('X limit boundary with Arabic text', () => {
  const ok = 'ح'.repeat(X_MAX_WEIGHTED);
  const long = 'ح'.repeat(X_MAX_WEIGHTED + 1);
  assert.deepEqual(xTooLong([ok, long]), [2]);
});

test('countWords counts Arabic words and ignores punctuation-only tokens', () => {
  assert.equal(countWords('الحوكمة الرشيدة — أساس الاستدامة .'), 4);
});

const valid: DraftContent = {
  x_segments: ['تغريدة أولى', 'تغريدة ثانية'],
  linkedin_text: 'كلمة '.repeat(150).trim(),
  snap_script: ['إطار 1', 'إطار 2', 'إطار 3'],
  needs_visual: false,
  visual_brief: null,
  notes: null,
};

test('checkDraftLimits accepts a draft within all limits', () => {
  assert.deepEqual(checkDraftLimits(valid), []);
});

test('checkDraftLimits: long tweet is hard, word count and snap issues are soft', () => {
  const v = checkDraftLimits({
    ...valid,
    x_segments: ['ح'.repeat(300)],
    linkedin_text: 'كلمة '.repeat(50),
    snap_script: ['سطر\nسطر\nسطر'],
  });
  assert.equal(v.filter((x) => x.hard).length, 1);
  assert.match(v.find((x) => x.hard)?.message ?? '', /300/);
  assert.equal(v.filter((x) => !x.hard).length, 3);
});

test('checkDraftLimits: more than 6 tweets is hard', () => {
  const v = checkDraftLimits({ ...valid, x_segments: Array.from({ length: 7 }, (_, i) => `t${i}`) });
  assert.ok(v.some((x) => x.hard));
});

test('parseDraftContent trims, drops empty tweets and keeps nullable fields', () => {
  const c = parseDraftContent({
    x_segments: ['  أولى ', '', 'ثانية'],
    linkedin_text: ' نص ',
    snap_script: ['أ', ' '],
    needs_visual: true,
    visual_brief: 'بطاقة',
    notes: '',
  });
  assert.deepEqual(c.x_segments, ['أولى', 'ثانية']);
  assert.equal(c.linkedin_text, 'نص');
  assert.deepEqual(c.snap_script, ['أ']);
  assert.equal(c.visual_brief, 'بطاقة');
  assert.equal(c.notes, null);
});

test('parseDraftContent rejects wrong shapes', () => {
  assert.throws(() => parseDraftContent(null), ShapeError);
  assert.throws(() => parseDraftContent({ ...valid, x_segments: 'نص' }), ShapeError);
  assert.throws(() => parseDraftContent({ ...valid, x_segments: [] }), ShapeError);
  assert.throws(() => parseDraftContent({ ...valid, needs_visual: 'yes' }), ShapeError);
});
