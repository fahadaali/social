import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CRON_DAILY, CRON_MIDWEEK_EVENTS, CRON_WEEKLY_PLAN, CRON_WEEKLY_REPORT, cronKey } from '../../src/schedule.ts';

const TASK_KEYS = [CRON_DAILY, CRON_WEEKLY_PLAN, CRON_MIDWEEK_EVENTS, CRON_WEEKLY_REPORT];

/** [triggers] crons كما في wrangler.toml. */
function configuredCrons(): string[] {
  const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
  const line = /^crons\s*=\s*\[(.*)\]\s*$/m.exec(toml);
  assert.ok(line, 'crons line in wrangler.toml');
  return [...line[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

test('wrangler.toml schedules match the tasks, one to one', () => {
  assert.deepEqual(configuredCrons().map(cronKey).sort(), [...TASK_KEYS].sort());
});

test('weekdays are written in the form Cloudflare accepts (1 = Sunday, or names), never 0', () => {
  for (const cron of configuredCrons()) {
    const fields = cron.split(/\s+/);
    assert.equal(fields.length, 5, cron);
    const day = fields[4]!;
    assert.match(day, /^(\*|SUN|MON|TUE|WED|THU|FRI|SAT)$/, `${cron}: use a day name, not a number`);
  }
});

test('the schedules keep the times SPEC §9 intended (Riyadh = UTC+3)', () => {
  assert.equal(CRON_DAILY, '0 6 * * *'); // يومياً 9:00 ص
  assert.equal(CRON_WEEKLY_PLAN, '0 5 * * SUN'); // الأحد 8:00 ص
  assert.equal(CRON_MIDWEEK_EVENTS, '0 5 * * WED'); // الأربعاء 8:00 ص
  assert.equal(CRON_WEEKLY_REPORT, '0 14 * * THU'); // الخميس 5:00 م
});

test('cronKey reads whatever form Cloudflare passes back', () => {
  assert.equal(cronKey('0 5 * * SUN'), CRON_WEEKLY_PLAN);
  assert.equal(cronKey(' 0  5 * * sun '), CRON_WEEKLY_PLAN);
  assert.equal(cronKey('0 5 * * 1'), CRON_WEEKLY_PLAN, 'Cloudflare numbering: 1 = Sunday');
  assert.equal(cronKey('0 5 * * 4'), CRON_MIDWEEK_EVENTS);
  assert.equal(cronKey('0 14 * * 5'), CRON_WEEKLY_REPORT);
  assert.equal(cronKey('0 6 * * *'), CRON_DAILY);
  assert.equal(cronKey('0 5 * * 0'), '0 5 * * 0', 'not a Cloudflare weekday: no task');
});
