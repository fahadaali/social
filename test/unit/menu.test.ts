import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOT_COMMANDS, MENU_LABELS, menuCommand, menuKeyboard } from '../../src/menu.ts';

test('every grid label maps to its command; other texts stay ideas', () => {
  for (const [command, label] of Object.entries(MENU_LABELS)) assert.equal(menuCommand(label), `/${command}`, label);
  // تطبيقات قد تحذف محدِّد شكل الإيموجي أو تضيف مسافات
  assert.equal(menuCommand('▶ استأنف التذكير'), '/resume');
  assert.equal(menuCommand('  💡 أفكاري '), '/ideas');
  for (const text of ['أفكاري', '💡 أفكاري الجديدة', 'قائمة الانتظار', '']) assert.equal(menuCommand(text), null, text);
});

test('the grid: 4 rows × 2, persistent, reminder button follows the paused state', () => {
  const texts = (paused: boolean) => menuKeyboard(paused).keyboard.map((r) => r.map((b) => b.text));
  assert.deepEqual(texts(false), [
    ['💡 أفكاري', '📋 قائمة الانتظار'],
    ['🗓 اقترح موضوعات', '📊 تقرير الأداء'],
    ['💳 الرصيد', '💾 نسخة احتياطية'],
    ['⏸ أوقف التذكير', '❓ مساعدة'],
  ]);
  assert.equal(texts(true)[3]?.[0], '▶️ استأنف التذكير');
  const kb = menuKeyboard(false);
  assert.equal(kb.is_persistent, true);
  assert.equal(kb.resize_keyboard, true);
  assert.ok((kb.input_field_placeholder ?? '').length <= 64);
});

test('the command menu is valid for setMyCommands and covers every grid command', () => {
  for (const c of BOT_COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(c.description.length >= 1 && c.description.length <= 256);
  }
  assert.deepEqual(BOT_COMMANDS.map((c) => c.command).sort(), Object.keys(MENU_LABELS).sort());
});
