import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyMigrations, splitSql, type Migration } from '../../src/schema.ts';

const file = (name: string) => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');

test('splitSql drops comments and splits the real migration files into statements', () => {
  const init = splitSql(file('0001_init.sql'));
  assert.deepEqual(
    init.map((s) => /^CREATE TABLE (\w+)/.exec(s)?.[1]),
    ['ideas', 'drafts', 'state', 'processed_updates'],
  );
  assert.ok(init.every((s) => !s.includes('--')), 'no comments left');
  assert.ok(init[1]?.includes(`DEFAULT '["x","linkedin"]'`), 'string defaults survive');
  assert.deepEqual(splitSql(file('0002_draft_notes.sql')), ['ALTER TABLE drafts ADD COLUMN notes TEXT']);
});

/** قاعدة D1 وهمية بقدر ما يحتاجه applyMigrations. */
function fakeDb(opts: { applied?: string[]; batchFails?: (names: string[]) => boolean; appliedByOther?: string[] } = {}) {
  const applied = [...(opts.applied ?? [])];
  const batches: string[][] = [];
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    run: async () => ({}),
    all: async () => ({ results: applied.map((name) => ({ name })) }),
    first: async () => (applied.includes(String(params[0])) ? { ok: 1 } : null),
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => {
      const name = String(list.at(-1)?.params[0]);
      batches.push(list.map((s) => s.sql));
      if (opts.batchFails?.([name])) {
        if (opts.appliedByOther?.includes(name)) applied.push(name); // Worker آخر سبقه
        throw new Error('table ideas already exists');
      }
      applied.push(name);
      return [];
    },
  };
  return { db: db as unknown as D1Database, applied, batches };
}

const MIGRATIONS: Migration[] = [
  { name: '0001_init.sql', sql: 'CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y TEXT);' },
  { name: '0002_more.sql', sql: '-- تعليق\nALTER TABLE a ADD COLUMN z TEXT;' },
];

test('applyMigrations runs only pending migrations, each atomically with its record', async () => {
  const fresh = fakeDb();
  assert.deepEqual(await applyMigrations(fresh.db, MIGRATIONS), ['0001_init.sql', '0002_more.sql']);
  assert.deepEqual(fresh.batches[0], ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y TEXT)', 'INSERT INTO d1_migrations (name) VALUES (?)']);

  const partial = fakeDb({ applied: ['0001_init.sql'] });
  assert.deepEqual(await applyMigrations(partial.db, MIGRATIONS), ['0002_more.sql']);
  assert.equal(partial.batches.length, 1);

  const done = fakeDb({ applied: ['0001_init.sql', '0002_more.sql'] });
  assert.deepEqual(await applyMigrations(done.db, MIGRATIONS), []);
  assert.equal(done.batches.length, 0);
});

test('a concurrent start that already applied the migration is not an error; a real failure is', async () => {
  const raced = fakeDb({ batchFails: ([n]) => n === '0001_init.sql', appliedByOther: ['0001_init.sql'] });
  assert.deepEqual(await applyMigrations(raced.db, MIGRATIONS), ['0002_more.sql']);

  const broken = fakeDb({ batchFails: ([n]) => n === '0002_more.sql' });
  await assert.rejects(applyMigrations(broken.db, MIGRATIONS), /already exists/);
});
