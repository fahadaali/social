import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft } from '../../src/db.ts';
import {
  archivedIdeaRow,
  CB,
  draftKeyboard,
  ideaListRow,
  previewKeyboard,
  renderPreview,
  replaceIdeaRow,
  rescheduleKeyboard,
  scheduleKeyboard,
  snapCopyMessages,
} from '../../src/preview.ts';
import { fingerprint, postFingerprint } from '../../src/publishing.ts';
import { MAX_MESSAGE_LENGTH } from '../../src/telegram.ts';
import { scheduleOptions, toSqlUtc } from '../../src/time.ts';

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
  const pfp = postFingerprint({ status: 'scheduled', socialapi_post_id: 'p_01HZ9X3Q4R5M6N7P8V2K0W1J', scheduled_at: '2099-12-31 17:00:00' });
  all.push(
    CB.confirmSchedule(999999, fingerprint(d), 4102444800),
    CB.planPick('abcdef12', 2),
    CB.retry('e', 999999),
    CB.rescheduleAt(999999, 4102444800),
    CB.confirmReschedule(999999, pfp, 4102444800),
    CB.confirmCancel(999999, pfp),
    CB.confirmRetry(999999, pfp),
    CB.unarchiveIdea(999999),
    ...['scheduled', 'partial', 'publishing', 'published'].flatMap((status) =>
      previewKeyboard(makeDraft({ id: 999999, status: status as Draft['status'], socialapi_post_id: 'p_1' })).inline_keyboard.flat().map((b) => b.callback_data),
    ),
  );
  for (const data of all) assert.ok(new TextEncoder().encode(data).length <= 64, data);
});

test('previewKeyboard gives each status its own buttons; Snap copy everywhere except rejected', () => {
  const texts = (d: Draft) => previewKeyboard(d).inline_keyboard.map((r) => r.map((b) => b.text));
  const withPost = { socialapi_post_id: 'p_1' };
  assert.deepEqual(texts(makeDraft({ status: 'scheduled', ...withPost })), [['🕒 غيّر الموعد', '🚫 ألغِ الجدولة'], ['📋 سكربت سناب']]);
  assert.deepEqual(texts(makeDraft({ status: 'partial', ...withPost })), [['🔁 أعد محاولة ما فشل'], ['📋 سكربت سناب']]);
  assert.deepEqual(texts(makeDraft({ status: 'publishing', ...withPost })), [['🔄 تحقق من الحالة'], ['📋 سكربت سناب']]);
  assert.deepEqual(texts(makeDraft({ status: 'published', ...withPost })), [['📋 سكربت سناب']]);
  assert.deepEqual(texts(makeDraft({ status: 'published', ...withPost, snap_script: [] })), []);
  assert.deepEqual(texts(makeDraft({ status: 'rejected' })), []);
  // بلا منشور في SocialAPI لا أزرار إدارة
  assert.deepEqual(texts(makeDraft({ status: 'scheduled' })), [['📋 سكربت سناب']]);
  // المعلّقة: أزرارها الكاملة، وسكربت سناب بجوار الصورة
  const pending = texts(makeDraft());
  assert.deepEqual(pending[2], ['🖼 أرفق صورة', '📋 سكربت سناب']);
  assert.deepEqual(previewKeyboard(makeDraft()), draftKeyboard(makeDraft()));
  assert.deepEqual(texts(makeDraft({ snap_script: [] }))[2], ['🖼 أرفق صورة']);
});

test('reschedule options hide the current slot and end with «رجوع»', () => {
  const now = new Date('2026-09-22T12:00:00Z'); // 3 م بالرياض
  const options = scheduleOptions(now);
  const current = options.find((o) => o.label === 'غداً 8م');
  assert.ok(current);
  const d = makeDraft({ status: 'scheduled', socialapi_post_id: 'p_1', scheduled_at: toSqlUtc(current.at) });
  const buttons = rescheduleKeyboard(d, options).inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['اليوم 8م', 'غداً 8ص', 'بعد غد 8ص', '↩️ رجوع']);
  assert.ok(buttons.slice(0, -1).every((b) => b.callback_data.startsWith('rsa:7:')));
  assert.equal(buttons.at(-1)?.callback_data, 'bk:7');
});

test('Snap copy: each frame is a pre block at exact UTF-16 offsets; long scripts split within the limit', () => {
  const frames = ['إطار أول\nسطر ثانٍ', 'إطار 😀 ثانٍ', 'ثالث'];
  const [only, ...rest] = snapCopyMessages({ id: 7, snap_script: frames });
  assert.equal(rest.length, 0);
  assert.ok(only?.text.startsWith('📋 سكربت سناب — المسودة #7\nالمس أي إطار لنسخه:'));
  assert.deepEqual(
    only?.entities.map((e) => only.text.slice(e.offset, e.offset + e.length)),
    frames,
  );
  assert.ok(only?.entities.every((e) => e.type === 'pre'));

  const big = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(2_000));
  const parts = snapCopyMessages({ id: 7, snap_script: big });
  assert.ok(parts.length >= 3);
  const shown: string[] = [];
  for (const p of parts) {
    assert.ok(p.text.length <= MAX_MESSAGE_LENGTH);
    for (const e of p.entities) shown.push(p.text.slice(e.offset, e.offset + e.length));
  }
  assert.deepEqual(shown, big);

  // إطار أطول من الحد يُقص دون شطر إيموجي
  const [cut] = snapCopyMessages({ id: 7, snap_script: ['ا'.repeat(2_999) + '😀😀'] });
  const e = cut?.entities[0];
  assert.ok(cut && e && cut.text.length <= MAX_MESSAGE_LENGTH);
  assert.equal(cut.text.slice(e.offset, e.offset + e.length), 'ا'.repeat(2_999) + '…');
});

test('/ideas rows: «أرشف» ⇄ «تراجع» replace only that idea\'s row', () => {
  const kb = { inline_keyboard: [ideaListRow(2), ideaListRow(1)] };
  const archived = replaceIdeaRow(kb, 2, archivedIdeaRow(2));
  assert.deepEqual(archived?.inline_keyboard.map((r) => r.map((b) => b.callback_data)), [['una:2'], ['fmt:1', 'arc:1']]);
  const back = replaceIdeaRow(archived ?? undefined, 2, ideaListRow(2));
  assert.deepEqual(back, kb);
  assert.equal(replaceIdeaRow(kb, 9, archivedIdeaRow(9)), null);
  assert.equal(replaceIdeaRow(undefined, 2, archivedIdeaRow(2)), null);
});

test('keyboard shows platform toggles and hides for non-editable drafts', () => {
  const kb = draftKeyboard(makeDraft({ platforms: ['linkedin'], media_id: 'm' }));
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('X ✗'));
  assert.ok(labels.includes('LinkedIn ✓'));
  assert.ok(labels.includes('🖼 استبدل الصورة'));
  assert.deepEqual(draftKeyboard(makeDraft({ status: 'scheduled' })).inline_keyboard, []);
});

test('post fingerprint changes with status, post id and scheduled time', () => {
  const base = { status: 'scheduled' as const, socialapi_post_id: 'p_1', scheduled_at: '2026-09-24 17:00:00' };
  const fp = postFingerprint(base);
  assert.match(fp, /^[0-9a-z]{1,8}$/);
  assert.equal(postFingerprint({ ...base }), fp);
  assert.notEqual(postFingerprint({ ...base, status: 'pending' }), fp);
  assert.notEqual(postFingerprint({ ...base, socialapi_post_id: 'p_2' }), fp);
  assert.notEqual(postFingerprint({ ...base, scheduled_at: '2026-09-25 05:00:00' }), fp);
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
