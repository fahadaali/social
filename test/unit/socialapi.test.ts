import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Env } from '../../src/env.ts';
import {
  buildPostRequest,
  buildValidateRequest,
  ConfigError,
  describeIssue,
  SocialApiError,
  socialApiErrorMessage,
  type PublishableDraft,
} from '../../src/socialapi.ts';

const env = { SOCIALAPI_X_ACCOUNT_ID: 'acc_x', SOCIALAPI_LINKEDIN_ACCOUNT_ID: 'acc_li' } as Env;
const draft: PublishableDraft = {
  x_segments: ['الأولى', 'الثانية', 'الثالثة'],
  linkedin_text: 'نص لينكدن',
  media_id: null,
  platforms: ['x', 'linkedin'],
};

test('one post, two targets: thread in X platform_data only, LinkedIn text as target override', () => {
  const p = buildPostRequest(env, draft, { kind: 'draft' });
  assert.deepEqual(p.targets, [
    {
      account_id: 'acc_x',
      text: 'الأولى',
      platform_data: {
        thread: [
          { text: 'الثانية', media_ids: [] },
          { text: 'الثالثة', media_ids: [] },
        ],
      },
    },
    { account_id: 'acc_li', text: 'نص لينكدن' },
  ]);
  assert.equal(p.text, 'الأولى');
});

test('DRY_RUN draft has neither publish_now nor scheduled_at (saved as a free draft)', () => {
  const p = buildPostRequest(env, draft, { kind: 'draft' });
  assert.equal('publish_now' in p, false);
  assert.equal('scheduled_at' in p, false);
});

test('publish now / schedule modes', () => {
  const now = buildPostRequest(env, draft, { kind: 'now' });
  assert.equal(now.publish_now, true);
  assert.equal('scheduled_at' in now, false);
  const at = buildPostRequest(env, draft, { kind: 'schedule', at: '2026-09-24T17:00:00Z' });
  assert.equal(at.scheduled_at, '2026-09-24T17:00:00Z');
  assert.equal('publish_now' in at, false);
});

test('image goes to the LinkedIn target only', () => {
  const p = buildPostRequest(env, { ...draft, media_id: 'm1' }, { kind: 'now' });
  assert.equal(p.targets[0]?.media, undefined);
  assert.deepEqual(p.targets[1]?.media, [{ source_type: 'media_id', source: 'm1' }]);
});

test('single tweet has no thread; LinkedIn-only post uses LinkedIn text', () => {
  const single = buildPostRequest(env, { ...draft, x_segments: ['وحيدة'] }, { kind: 'now' });
  assert.equal(single.targets[0]?.platform_data, undefined);
  const li = buildPostRequest(env, { ...draft, platforms: ['linkedin'] }, { kind: 'now' });
  assert.equal(li.targets.length, 1);
  assert.equal(li.text, 'نص لينكدن');
});

test('missing account id or no platform → ConfigError', () => {
  assert.throws(() => buildPostRequest({ ...env, SOCIALAPI_X_ACCOUNT_ID: '' }, draft, { kind: 'now' }), ConfigError);
  assert.throws(() => buildPostRequest(env, { ...draft, platforms: [] }, { kind: 'now' }), ConfigError);
});

test('validate request mirrors targets and adds account_ids and schedule', () => {
  const p = buildPostRequest(env, draft, { kind: 'draft' });
  const v = buildValidateRequest(p, '2026-09-24T17:00:00Z');
  assert.deepEqual(v.account_ids, ['acc_x', 'acc_li']);
  assert.equal(v.scheduled_at, '2026-09-24T17:00:00Z');
  assert.deepEqual(v.targets, p.targets);
});

test('error messages follow SPEC §11 with 429 split by documented codes', () => {
  const msg = (status: number, code: string, meta = {}) => socialApiErrorMessage(new SocialApiError(status, code, '', meta));
  assert.equal(msg(429, 'billing.post_limit'), 'بلغتَ حد منشورات الشهر في SocialAPI.');
  assert.equal(msg(429, 'unknown.code'), 'بلغتَ حد منشورات الشهر في SocialAPI.');
  assert.match(msg(429, 'publishing.velocity_limit'), /تحدّ من سرعة/);
  assert.match(msg(429, 'ratelimit.exceeded'), /تحدّ من سرعة/);
  assert.match(msg(429, 'platform.twitter.rate_limit'), /تحدّ من سرعة/);
  assert.equal(msg(401, 'platform.twitter.auth'), 'يلزم إعادة ربط حساب X من لوحة SocialAPI.');
  assert.equal(msg(403, 'platform.linkedin.permission_denied'), 'يلزم إعادة ربط حساب لينكدن من لوحة SocialAPI.');
  assert.match(msg(403, 'account.reconnection_required'), /يلزم إعادة ربط حساب/);
  assert.match(msg(401, 'auth.invalid_key'), /مفتاح SocialAPI غير صالح/);
  assert.match(msg(403, 'auth.insufficient_scope', { required_scope: 'posts:write' }), /posts:write/);
  assert.match(msg(0, 'network.timeout'), /تعذّر الاتصال/);
});

test('validation issues are described with platform and tweet position', () => {
  assert.equal(
    describeIssue({ platform: 'twitter', segment_index: 0, field: 'text', message: 'too long' }),
    '[X · تغريدة 2 · text] too long',
  );
});
