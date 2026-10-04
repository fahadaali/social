import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bannedIn, checkStyle, normalizeArabic } from '../../src/style.ts';
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
