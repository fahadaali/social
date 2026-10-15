import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientD1Error, retryTransientD1 } from '../../src/db.ts';

const lost = () => new Error('D1_ERROR: Network connection lost.');

test('the transient D1 errors Cloudflare documents are recognised, others are not', () => {
  assert.ok(isTransientD1Error(lost()));
  assert.ok(isTransientD1Error(new Error('D1_ERROR: internal error; reference = x: storage caused object to be reset')));
  assert.ok(isTransientD1Error(new Error('D1_ERROR: Durable Object reset because its code was updated.')));
  assert.ok(!isTransientD1Error(new Error('D1_ERROR: no such table: drafts')));
  assert.ok(!isTransientD1Error('Network connection lost'));
});

test('a transient D1 error is retried once, and the second result is returned', async () => {
  let calls = 0;
  const retried: unknown[] = [];
  const out = await retryTransientD1(
    async () => {
      if (++calls === 1) throw lost();
      return 'ok';
    },
    () => true,
    0,
    (err) => retried.push(err),
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.equal(retried.length, 1);
});

test('only one retry: a second transient failure is thrown', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientD1(async () => { calls++; throw lost(); }, () => true, 0),
    /Network connection lost/,
  );
  assert.equal(calls, 2);
});

test('no retry for a non-transient error, or when canRetry says no', async () => {
  let calls = 0;
  await assert.rejects(retryTransientD1(async () => { calls++; throw new Error('boom'); }, () => true, 0), /boom/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retryTransientD1(async () => { calls++; throw lost(); }, () => false, 0), /Network/);
  assert.equal(calls, 1);
});
