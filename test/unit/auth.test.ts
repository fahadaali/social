import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { ownerChat, webhookSecret } from '../../src/auth.ts';
import { daysAr } from '../../src/text.ts';
import type { TgUpdate } from '../../src/telegram.ts';

const OWNER = '111';
const msg = (fromId: number, chatId: number, type = 'private'): TgUpdate => ({
  update_id: 1,
  message: { message_id: 1, date: 0, from: { id: fromId }, chat: { id: chatId, type }, text: 'x' },
});

test('only the owner in a private chat is accepted', () => {
  assert.equal(ownerChat(msg(111, 111), OWNER), 111);
  assert.equal(ownerChat(msg(222, 222), OWNER), null);
  assert.equal(ownerChat(msg(111, -100, 'group'), OWNER), null);
  assert.equal(ownerChat(msg(111, 111), null), null); // owner not configured → ignore everything
});

test('callbacks from others and other update types are ignored', () => {
  const cb = (fromId: number): TgUpdate => ({
    update_id: 2,
    callback_query: { id: 'q', from: { id: fromId }, data: 'pub:1', message: { message_id: 5, date: 0, chat: { id: 111, type: 'private' } } },
  });
  assert.equal(ownerChat(cb(111), OWNER), 111);
  assert.equal(ownerChat(cb(222), OWNER), null);
  const edited: TgUpdate = { update_id: 3, edited_message: { message_id: 1, date: 0, from: { id: 111 }, chat: { id: 111, type: 'private' } } };
  assert.equal(ownerChat(edited, OWNER), null);
});

test('Arabic day counts', () => {
  assert.equal(daysAr(1), 'يوم واحد');
  assert.equal(daysAr(2), 'يومان');
  assert.equal(daysAr(4), '4 أيام');
  assert.equal(daysAr(11), '11 يوماً');
});

test('webhook secret: explicit value wins; otherwise derived from the bot token in Telegram\'s allowed charset', async () => {
  assert.equal(await webhookSecret({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_WEBHOOK_SECRET: ' mine ' }), 'mine');
  const derived = await webhookSecret({ TELEGRAM_BOT_TOKEN: '1:abc' });
  assert.equal(derived, createHmac('sha256', '1:abc').update('social-bot:telegram-webhook-secret').digest('base64url'));
  assert.match(derived ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await webhookSecret({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_WEBHOOK_SECRET: '' }), derived);
  assert.notEqual(await webhookSecret({ TELEGRAM_BOT_TOKEN: '2:xyz' }), derived);
  assert.equal(await webhookSecret({ TELEGRAM_BOT_TOKEN: '' }), null);
});
