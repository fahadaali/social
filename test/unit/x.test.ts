import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import type { Env } from '../../src/env.ts';
import { oauthHeader, percentEncode, xErrorMessage, XApiError, xUploadConfigured } from '../../src/x.ts';

test('percentEncode follows RFC 3986 (OAuth 1.0a)', () => {
  assert.equal(percentEncode("Ladies + Gentlemen!*'()"), 'Ladies%20%2B%20Gentlemen%21%2A%27%28%29');
  assert.equal(percentEncode('a-b_c.d~e'), 'a-b_c.d~e');
});

// مفاتيح مثال توثيق X «Creating a signature»، والتوقيع المتوقع محسوب هنا مستقلاً بـ node:crypto
test('oauthHeader signs with HMAC-SHA1 over the OAuth params only (multipart body excluded)', async () => {
  const keys = {
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  };
  const header = await oauthHeader('POST', 'https://api.x.com/2/media/upload', keys, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958');
  assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", /);
  assert.match(header, /oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"$/);
  const params =
    'oauth_consumer_key=xvz1evFS4wEEPTGEFPHBog&oauth_nonce=kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg&oauth_signature_method=HMAC-SHA1' +
    '&oauth_timestamp=1318622958&oauth_token=370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb&oauth_version=1.0';
  const base = `POST&${encodeURIComponent('https://api.x.com/2/media/upload')}&${encodeURIComponent(params)}`;
  const expected = createHmac('sha1', `${keys.consumerSecret}&${keys.tokenSecret}`).update(base).digest('base64');
  assert.ok(header.includes(`oauth_signature="${percentEncode(expected)}"`), header);
  // نفس المدخلات تعطي نفس التوقيع، وتغيير السر يغيّره
  const again = await oauthHeader('POST', 'https://api.x.com/2/media/upload', keys, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958');
  assert.equal(again, header);
  const other = await oauthHeader('POST', 'https://api.x.com/2/media/upload', { ...keys, tokenSecret: 'x' }, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958');
  assert.notEqual(other, header);
});

test('X upload needs all four keys', () => {
  const full = { X_API_KEY: 'a', X_API_SECRET: 'b', X_ACCESS_TOKEN: 'c', X_ACCESS_TOKEN_SECRET: 'd' } as Env;
  assert.equal(xUploadConfigured(full), true);
  assert.equal(xUploadConfigured({ ...full, X_ACCESS_TOKEN_SECRET: ' ' } as Env), false);
  assert.equal(xUploadConfigured({} as Env), false);
});

test('X upload error messages', () => {
  assert.match(xErrorMessage(new XApiError(401, '')), /X_API_KEY/);
  assert.match(xErrorMessage(new XApiError(403, 'Forbidden')), /Read and write/);
  assert.match(xErrorMessage(new XApiError(413, 'too_large')), /5MB/);
  assert.match(xErrorMessage(new XApiError(0, 'timeout')), /تعذّر الاتصال/);
});
