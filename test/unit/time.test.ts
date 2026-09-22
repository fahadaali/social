import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  daysBetween,
  formatClock,
  formatRiyadh,
  parseUtc,
  riyadhParts,
  riyadhToUtc,
  scheduleOptions,
  toRfc3339,
  toSqlUtc,
} from '../../src/time.ts';

test('Riyadh is UTC+3 all year', () => {
  assert.equal(riyadhToUtc(2026, 9, 24, 20).toISOString(), '2026-09-24T17:00:00.000Z');
  assert.equal(riyadhToUtc(2026, 1, 15, 8).toISOString(), '2026-01-15T05:00:00.000Z');
  assert.deepEqual(riyadhParts(new Date('2026-09-22T22:30:00Z')), {
    year: 2026, month: 9, day: 23, hour: 1, minute: 30, weekday: 3,
  });
});

test('cron times in the spec map to Riyadh correctly', () => {
  // 0 6 * * * UTC → 9:00 ص الرياض
  assert.equal(riyadhParts(new Date('2026-09-22T06:00:00Z')).hour, 9);
  // 0 5 * * 0 → الأحد 8:00 ص ، 0 14 * * 4 → الخميس 5:00 م
  assert.equal(riyadhParts(new Date('2026-09-27T05:00:00Z')).hour, 8);
  assert.equal(riyadhParts(new Date('2026-09-24T14:00:00Z')).hour, 17);
});

test('schedule options at 3pm Riyadh: all four', () => {
  const opts = scheduleOptions(new Date('2026-09-22T12:00:00Z'));
  assert.deepEqual(
    opts.map((o) => [o.label, o.at.toISOString()]),
    [
      ['اليوم 8م', '2026-09-22T17:00:00.000Z'],
      ['غداً 8ص', '2026-09-23T05:00:00.000Z'],
      ['غداً 8م', '2026-09-23T17:00:00.000Z'],
      ['بعد غد 8ص', '2026-09-24T05:00:00.000Z'],
    ],
  );
});

test('schedule options drop "today 8pm" when it is too close or past', () => {
  assert.equal(scheduleOptions(new Date('2026-09-22T16:50:00Z')).length, 3); // 7:50م
  assert.equal(scheduleOptions(new Date('2026-09-22T19:00:00Z')).length, 3); // 10:00م
});

test('schedule options roll over the month end', () => {
  const opts = scheduleOptions(new Date('2026-09-30T20:00:00Z')); // 11pm Riyadh on the 30th
  assert.equal(opts[0]?.at.toISOString(), '2026-10-01T05:00:00.000Z');
});

test('formatting in Arabic', () => {
  assert.equal(formatRiyadh(new Date('2026-09-24T17:00:00Z')), 'الخميس 24 سبتمبر، 8:00 م');
  assert.equal(formatClock(0, 5), '12:05 ص');
  assert.equal(formatClock(12, 0), '12:00 م');
});

test('SQLite and RFC3339 conversions', () => {
  const d = new Date('2026-09-24T17:00:00.123Z');
  assert.equal(toSqlUtc(d), '2026-09-24 17:00:00');
  assert.equal(toRfc3339(d), '2026-09-24T17:00:00Z');
  assert.equal(parseUtc('2026-09-24 17:00:00').toISOString(), '2026-09-24T17:00:00.000Z');
  assert.equal(parseUtc('2026-09-24T17:00:00Z').toISOString(), '2026-09-24T17:00:00.000Z');
  assert.equal(daysBetween(new Date('2026-09-18T06:00:00Z'), new Date('2026-09-22T06:00:00Z')), 4);
});
