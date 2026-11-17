import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engagementTotal, metricsNotes, performanceSection, performanceTargets, pillarStats, type PostPerformance } from '../../src/analytics.ts';
import { parseReport, reportUser } from '../../src/prompts/report.ts';
import { planUser } from '../../src/prompts/plan.ts';
import { computeCredits } from '../../src/publishing.ts';
import { readEngagement } from '../../src/socialapi.ts';
import { postsAr } from '../../src/text.ts';

test('readEngagement accepts both documented field names and keeps missing values as null', () => {
  assert.deepEqual(readEngagement({ likes: 5, comments: 2, shares: 1, saves: 0 }), { likes: 5, comments: 2, shares: 1, saves: 0 });
  assert.deepEqual(readEngagement({ like_count: 7, comments_count: 3 }), { likes: 7, comments: 3, shares: null, saves: null });
  assert.deepEqual(readEngagement(undefined), { likes: null, comments: null, shares: null, saves: null });
});

test('engagement total ignores unavailable numbers and is null when nothing is available', () => {
  assert.equal(engagementTotal([{ likes: 5, comments: null, shares: 1, saves: null }, { likes: null, comments: 2, shares: null, saves: 0 }]), 8);
  assert.equal(engagementTotal([{ likes: null, comments: null, shares: null, saves: null }]), null);
  assert.equal(engagementTotal([]), null);
});

test('pillar stats average only measured posts and rank by average', () => {
  const stats = pillarStats([
    { pillar: 'أ', total: 10 },
    { pillar: 'أ', total: 30 },
    { pillar: 'ب', total: 50 },
    { pillar: 'ج', total: null },
    { pillar: null, total: 4 },
  ]);
  assert.deepEqual(stats.map((s) => [s.pillar, s.posts, s.measured, s.avg]), [
    ['ب', 1, 1, 50],
    ['أ', 2, 2, 20],
    ['غير مصنّف', 1, 1, 4],
    ['ج', 1, 0, null],
  ]);
});

test('performance section for the plan: absent without numbers, cautious with few', () => {
  assert.equal(performanceSection(null), null);
  assert.equal(performanceSection({ at: '2026-09-20 10:00:00', days: 30, items: [{ draft_id: 1, pillar: 'أ', title: 't', total: null }] }), null);
  const few = performanceSection({ at: '2026-09-20 10:00:00', days: 30, items: [{ draft_id: 1, pillar: 'أ', title: 'عنوان', total: 12 }] });
  assert.match(few ?? '', /- أ: منشور واحد، متوسط التفاعل 12/);
  assert.match(few ?? '', /الأرقام قليلة/);
  assert.match(planUser('اليوم', [], [], few), /<performance>[\s\S]*متوسط التفاعل 12[\s\S]*<\/performance>/);
  assert.doesNotMatch(planUser('اليوم', [], []), /<performance>/);
});

const item = (over: Partial<PostPerformance>): PostPerformance => ({
  draft_id: 1,
  pillar: 'الحوكمة',
  title: 'عنوان',
  published_at: '2026-09-20 10:00:00',
  platforms: [],
  total: null,
  failed: false,
  ...over,
});

test('report prompt shows unavailable numbers as «غير متوفر» and flags low data', () => {
  const items = [
    item({ draft_id: 7, platforms: [{ platform: 'X', likes: 10, comments: 2, shares: null, saves: null }, { platform: 'لينكدن', likes: null, comments: null, shares: null, saves: null }], total: 12 }),
    item({ draft_id: 8, failed: true }),
  ];
  const text = reportUser('الخميس', items, pillarStats(items));
  assert.match(text, /#7 \[الحوكمة\].*X: إعجابات 10، تعليقات 2، مشاركات غير متوفر، حفظ غير متوفر \| لينكدن: إعجابات غير متوفر/);
  assert.match(text, /#8 .*تعذّر جلب المقاييس/);
  assert.match(text, /أعلى منشور تفاعلاً وفق الأرقام: #7 بمجموع 12/);
  assert.match(text, /البيانات قليلة \(1 من المنشورات فقط/);
  assert.match(text, /«غير متوفر» يعني أن المنصة لم تُرجع الرقم، وليس صفراً/);
});

test('parseReport requires all four non-empty fields', () => {
  const ok = { headline: 'h', top_post: 't', insight: 'i', next_week_tip: 'n' };
  assert.deepEqual(parseReport(ok), ok);
  assert.throws(() => parseReport({ ...ok, insight: ' ' }));
  assert.throws(() => parseReport({ headline: 'h' }));
});

test('credits: plan limit from SocialAPI, fallback limit, unlimited', () => {
  assert.deepEqual(computeCredits({ posts_used: 4, posts_limit: 10 }, 99), { unlimited: false, remaining: 6, used: 4, limit: 10, periodEnd: undefined });
  assert.equal(computeCredits({ posts_used: 3 }, 10).remaining, 7);
  assert.equal(computeCredits({ posts_used: 12, posts_limit: 10 }, 10).remaining, 0);
  assert.equal(computeCredits({ posts_used: 50, posts_limit: -1 }, 10).unlimited, true);
});

test('Arabic post counts', () => {
  assert.deepEqual([1, 2, 5, 11].map(postsAr), ['منشور واحد', 'منشوران', '5 منشورات', '11 منشوراً']);
});

test('performance targets keep the empty status SocialAPI returned before 2026-11-14, and carry target errors', () => {
  const rows = performanceTargets([
    { platform: 'twitter', status: '', metrics: { likes: 4, comments: 1, shares: 0, saves: 0 } },
    { platform: 'linkedin', status: 'published', error: { code: 'resource.not_supported', message: 'n/a', category: 'resource' } },
    { platform: 'twitter', status: 'failed' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(engagementTotal(rows), 5);
  assert.equal(rows[0]?.note, undefined);
  assert.match(rows[1]?.note ?? '', /لا تتيح مقاييس المنشورات/);
  const capped = performanceTargets([{ platform: 'twitter', status: 'published', error: { code: 'platform.twitter.usage_capped', message: 'x' } }]);
  assert.match(capped[0]?.note ?? '', /نفد رصيد تطبيق X/);
  const notes = metricsNotes([
    { draft_id: 1, pillar: null, title: 't', published_at: '2026-11-01 10:00:00', platforms: [...rows, ...capped], total: 5, failed: false },
    { draft_id: 2, pillar: null, title: 't', published_at: '2026-11-02 10:00:00', platforms: rows, total: 5, failed: false },
  ]);
  assert.deepEqual(notes.map((n) => n.split(':')[0]), ['لينكدن', 'X']);
});
