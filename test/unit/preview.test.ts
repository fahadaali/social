import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft } from '../../src/db.ts';
import { CB, draftKeyboard, renderPreview, scheduleKeyboard } from '../../src/preview.ts';
import { fingerprint } from '../../src/publishing.ts';
import { MAX_MESSAGE_LENGTH } from '../../src/telegram.ts';
import { scheduleOptions } from '../../src/time.ts';

function makeDraft(over: Partial<Draft> = {}): Draft {
  return {
    id: 7,
    idea_id: 12,
    x_segments: ['خطاف', 'ثانية', 'ثالثة', 'رابعة'],
    linkedin_text: 'نص لينكدن',
    snap_script: ['إطار 1', 'إطار 2', 'إطار 3'],
    needs_visual: true,
    visual_brief: 'بطاقة تلخّص الخطوات الثلاث',
    notes: null,
    media_id: null,
    platforms: ['x', 'linkedin'],
    status: 'pending',
    socialapi_post_id: null,
    scheduled_at: null,
    published_at: null,
    telegram_message_id: null,
    revision: 0,
    created_at: '2026-09-22 10:00:00',
    updated_at: '2026-09-22 10:00:00',
    ...over,
  };
}
const idea = { id: 12, text: 'فكرة', pillar: 'الحوكمة', source: 'text', status: 'drafted' as const, created_at: '' };

test('preview follows the SPEC §7 layout in one message', () => {
  const chunks = renderPreview(makeDraft(), idea);
  assert.equal(chunks.length, 1);
  const t = chunks[0] ?? '';
  assert.ok(t.startsWith('📝 مسودة #7 — المحور: الحوكمة (نسخة 1)'));
  assert.ok(t.includes('【X — ثريد من 4 تغريدات】\n1/ خطاف\n\n2/ ثانية'));
  assert.ok(t.includes('【LinkedIn】\nنص لينكدن'));
  assert.ok(t.includes('【سناب — للنشر اليدوي】'));
  assert.ok(t.includes('🖼 يُقترح تصميم: بطاقة تلخّص الخطوات الثلاث (صمّمه في Claude Design وأرسله هنا)'));
});

test('long preview splits into X then LinkedIn messages, each within the Telegram limit', () => {
  const d = makeDraft({
    x_segments: Array.from({ length: 6 }, () => 'ح'.repeat(279)),
    linkedin_text: 'ل'.repeat(3000),
    snap_script: Array.from({ length: 5 }, () => 'سطر أول\nسطر ثانٍ'),
    notes: 'تحقق من رقم المادة',
  });
  const chunks = renderPreview(d, idea);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= MAX_MESSAGE_LENGTH);
  assert.ok(chunks[0]?.includes('【X —'));
  assert.ok(!chunks[0]?.includes('【LinkedIn】'));
  assert.ok(chunks.at(-1)?.includes('🔎 للتحقق: تحقق من رقم المادة'));
});

test('all callback_data fit in 64 bytes even with large ids', () => {
  const d = makeDraft({ id: 999999, revision: 999 });
  const all = [
    ...draftKeyboard(d).inline_keyboard.flat(),
    ...scheduleKeyboard(d, scheduleOptions(new Date('2026-09-22T12:00:00Z'))).inline_keyboard.flat(),
  ].map((b) => b.callback_data);
  all.push(CB.confirmSchedule(999999, fingerprint(d), 4102444800), CB.planPick('abcdef12', 2), CB.retry('e', 999999));
  for (const data of all) assert.ok(new TextEncoder().encode(data).length <= 64, data);
});

test('keyboard shows platform toggles and hides for non-editable drafts', () => {
  const kb = draftKeyboard(makeDraft({ platforms: ['linkedin'], media_id: 'm' }));
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('X ✗'));
  assert.ok(labels.includes('LinkedIn ✓'));
  assert.ok(labels.includes('🖼 استبدل الصورة'));
  assert.deepEqual(draftKeyboard(makeDraft({ status: 'scheduled' })).inline_keyboard, []);
});

test('confirmation fingerprint changes with revision, platforms and image', () => {
  const base = makeDraft();
  const fp = fingerprint(base);
  assert.match(fp, /^[0-9a-z]{1,8}$/);
  assert.equal(fingerprint({ ...base, platforms: ['linkedin', 'x'] }), fp);
  assert.notEqual(fingerprint({ ...base, revision: 1 }), fp);
  assert.notEqual(fingerprint({ ...base, platforms: ['x'] }), fp);
  assert.notEqual(fingerprint({ ...base, media_id: 'm1' }), fp);
});
