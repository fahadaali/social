import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBase64 } from '../../src/encoding.ts';

test('toBase64 fallback matches Buffer for sizes around the 32KB chunk boundary', () => {
  for (const size of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 5, 100_003]) {
    const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
    assert.equal(toBase64(bytes.buffer, false), Buffer.from(bytes).toString('base64'), `size ${size}`);
  }
});

test('toBase64 default path (native in workerd, fallback in Node) gives standard base64', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  assert.equal(toBase64(bytes.buffer), '/9j/AQID');
});
