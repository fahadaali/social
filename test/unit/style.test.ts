import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bannedIn, checkStyle, normalizeArabic, requestedPhrases, similarity } from '../../src/style.ts';
import type { DraftContent } from '../../src/text.ts';

const clean: DraftContent = {
  x_segments: ['أغلب الخطط الاستراتيجية تفشل قبل أن تبدأ. السبب بسيط: لا أحد اختار ما لن يفعله.', 'المجلس الذي يوافق على كل شيء لم يقرر شيئاً.'],
  linkedin_text: 'راجعت هذا الأسبوع لائحة مجلس إدارة فيها اثنتا عشرة لجنة. الإخلال الجوهري بالعقد مصطلح نظامي، وضريبة القيمة المضافة كذلك.',
  snap_script: ['الخطة التي تقول نعم لكل شيء\nليست خطة', 'اختر'],
  needs_visual: false,
  visual_brief: null,
  notes: null,
};

test('normalizeArabic drops diacritics and tatweel, unifies alef', () => {
  assert.equal(normalizeArabic('دوراً'), 'دورا');
  assert.equal(normalizeArabic('إليك أهمّ'), 'اليك اهم');
  assert.equal(normalizeArabic('الحـــوكمة'), 'الحوكمة');
});

test('a plain draft passes; legal terms like جوهري and القيمة المضافة are allowed', () => {
  assert.deepEqual(checkStyle(clean), []);
});

test('bannedIn catches stock openings and closings despite diacritics and prefixes', () => {
  assert.deepEqual(bannedIn('في عالمِ اليومِ المتسارع تتغير الحوكمة'), ['في عالم اليوم']);
  assert.deepEqual(bannedIn('وختاماً، الحوكمة مهمة'), ['في الختام']);
  assert.deepEqual(bannedIn('مما لا شكّ فيه أن المجلس…'), ['لا شك أن']);
  assert.deepEqual(bannedIn('إليك ٥ أخطاء في الخطط'), ['إليك أهم…']);
  assert.deepEqual(bannedIn('ما رأيكم؟'), ['شاركونا / ما رأيكم؟']);
});

test('bannedIn catches inflated words, stock constructions and formatting habits', () => {
  assert.deepEqual(bannedIn('تلعب الحوكمة دوراً حيوياً'), ['يلعب دوراً حيوياً']);
  assert.deepEqual(bannedIn('الحوكمة ليست مجرد لوائح، بل ثقافة'), ['ليس مجرد… بل']);
  assert.deepEqual(bannedIn('المجلس — في الغالب — لا يقرر'), ['الشَّرطة الطويلة (—)']);
  assert.deepEqual(bannedIn('النقاط:\n✅ أولاً'), ['سطر يبدأ بإيموجي']);
  assert.deepEqual(bannedIn('هذا **مهم**'), ['خط عريض (**)']);
  assert.deepEqual(bannedIn('عنصر محوري ونقلة نوعية'), ['محوري', 'نقلة نوعية']);
});

test('an emoji inside a line is not a bullet', () => {
  assert.deepEqual(bannedIn('الخطة جاهزة ✅'), []);
});

test('checkStyle groups hits by platform, never hard, and flags more than two hashtags', () => {
  const v = checkStyle({
    ...clean,
    x_segments: ['في الختام، الحوكمة ليست مجرد لوائح'],
    linkedin_text: 'نص عادي #الحوكمة #التخطيط #القيادة',
  });
  assert.equal(v.length, 2);
  assert.ok(v.every((x) => !x.hard));
  assert.match(v[0]?.message ?? '', /^عبارات ممنوعة في X: «في الختام»، «ليس مجرد… بل»$/);
  assert.match(v[1]?.message ?? '', /وسوم لينكدن 3/);
});

test('checkStyle skips phrases the owner asked for by name', () => {
  const c = { ...clean, x_segments: ['وفي الختام، الحوكمة ليست مجرد لوائح'] };
  assert.deepEqual(requestedPhrases('أضف «وفي الختام» في آخرها'), ['في الختام']);
  const v = checkStyle(c, requestedPhrases('أضف «وفي الختام» في آخرها'));
  assert.equal(v.length, 1);
  assert.match(v[0]?.message ?? '', /^عبارات ممنوعة في X: «ليس مجرد… بل»$/);
});

test('similarity: 1 for the same draft, low for a real rewrite, and an edit confined to one platform still counts', () => {
  assert.equal(similarity(clean, clean), 1);
  assert.equal(similarity(clean, { ...clean, linkedin_text: `${clean.linkedin_text} ` }), 1, 'whitespace only');
  const rewritten = {
    ...clean,
    x_segments: ['قرأت خطة من أربعين صفحة لم تذكر شيئاً تتركه المنظمة.', 'الموافقة على كل بند ليست قراراً.'],
    linkedin_text: 'في مراجعة لائحة الأسبوع الماضي وجدت اثنتي عشرة لجنة لمجلس واحد. سألت: من يقرر؟ لم يجب أحد.',
    snap_script: ['خطة تقول نعم للكل\nلا تقول شيئاً', 'اختر ما تتركه'],
  };
  assert.ok(similarity(clean, rewritten) < 0.3);
  const xOnly = { ...clean, x_segments: ['قرأت خطة لم تذكر شيئاً تتركه المنظمة.', clean.x_segments[1] ?? ''] };
  assert.ok(similarity(clean, xOnly) < 0.95, 'changing the opening tweet alone is a change');
  // نص لينكدن بطوله المعتاد (120 كلمة فأكثر): تبديل كلمة واحدة لا يُعدّ تعديلاً
  const long = { ...clean, linkedin_text: Array.from({ length: 8 }, (_, i) => `الفقرة ${i}: ${clean.linkedin_text}`).join('\n\n') };
  const oneWord = { ...long, linkedin_text: long.linkedin_text.replace('هذا الأسبوع', 'هذا الشهر') };
  assert.ok(similarity(long, oneWord) >= 0.95, 'swapping a word is nearly unchanged');
});
