import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft } from '../../src/db.ts';
import { cancelRefusal, CHANGE_MIN_LEAD_MS, scheduledRefusal } from '../../src/managing.ts';
import type { Post } from '../../src/socialapi.ts';
import { toSqlUtc } from '../../src/time.ts';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms);

function draft(over: Partial<Draft> = {}): Draft {
  return {
    id: 7,
    idea_id: null,
    x_segments: ['تغريدة'],
    linkedin_text: 'نص',
    snap_script: [],
    needs_visual: false,
    visual_brief: null,
    notes: null,
    media_id: null,
    platforms: ['x', 'linkedin'],
    status: 'scheduled',
    socialapi_post_id: 'p_1',
    scheduled_at: toSqlUtc(at(60 * 60_000)),
    published_at: null,
    telegram_message_id: null,
    revision: 0,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const post = (over: Partial<Post> = {}): Post => ({
  id: 'p_1',
  status: 'scheduled',
  scheduled_at: at(60 * 60_000).toISOString(),
  targets: [
    { platform: 'twitter', status: 'pending' },
    { platform: 'linkedin', status: 'pending' },
  ],
  ...over,
});

test('change/cancel window: allowed only for a scheduled post more than 15 minutes away', () => {
  assert.equal(CHANGE_MIN_LEAD_MS, 15 * 60_000);
  assert.equal(scheduledRefusal(draft(), NOW), null);
  assert.equal(scheduledRefusal(draft({ scheduled_at: toSqlUtc(at(CHANGE_MIN_LEAD_MS + 1_000)) }), NOW), null);
  assert.match(scheduledRefusal(draft({ scheduled_at: toSqlUtc(at(CHANGE_MIN_LEAD_MS)) }), NOW) ?? '', /أقل من 15 دقيقة/);
  assert.match(scheduledRefusal(draft({ scheduled_at: toSqlUtc(at(-60_000)) }), NOW) ?? '', /أقل من 15 دقيقة/);
  assert.match(scheduledRefusal(draft({ scheduled_at: null }), NOW) ?? '', /غير معروف/);
  assert.match(scheduledRefusal(draft({ socialapi_post_id: null }), NOW) ?? '', /ليست مجدولة/);
  assert.match(scheduledRefusal(draft({ status: 'published' }), NOW) ?? '', /ليست مجدولة/);
});

test('DELETE guard: SocialAPI itself must show a scheduled post, far enough away, with nothing live', () => {
  assert.equal(cancelRefusal(post(), NOW), null);
  assert.match(cancelRefusal(post({ status: 'published' }), NOW) ?? '', /«منشور» وليست «مجدول»/);
  assert.match(cancelRefusal(post({ status: 'publishing' }), NOW) ?? '', /«قيد النشر»/);
  assert.match(cancelRefusal(post({ status: 'partial' }), NOW) ?? '', /«منشور جزئياً»/);
  assert.match(cancelRefusal(post({ scheduled_at: at(10 * 60_000).toISOString() }), NOW) ?? '', /أقل من 15 دقيقة/);
  assert.match(cancelRefusal(post({ scheduled_at: undefined }), NOW) ?? '', /لم يحدد/);
  assert.match(cancelRefusal(post({ scheduled_at: 'not a date' }), NOW) ?? '', /لم يحدد/);
  for (const status of ['published', 'publishing']) {
    const live = post({ targets: [{ platform: 'twitter', status }, { platform: 'linkedin', status: 'pending' }] });
    assert.match(cancelRefusal(live, NOW) ?? '', /بدأ نشر جزء/, status);
  }
  assert.equal(cancelRefusal(post({ targets: undefined }), NOW), null);
});
