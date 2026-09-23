// ترحيلات D1 مضمّنة في الـ Worker (من مجلد migrations/ كما هو)، وتُطبَّق عند أول استخدام لكل نسخة من الـ Worker.

import init from '../migrations/0001_init.sql';
import draftNotes from '../migrations/0002_draft_notes.sql';
import { applyMigrations, type Migration } from './schema.ts';

// بالترتيب، وبأسماء الملفات نفسها التي يسجّلها «wrangler d1 migrations apply»
export const MIGRATIONS: readonly Migration[] = [
  { name: '0001_init.sql', sql: init },
  { name: '0002_draft_notes.sql', sql: draftNotes },
];

let ready = false;

/**
 * يضمن جاهزية الجداول مرة لكل نسخة من الـ Worker؛ إن فشل يُعاد في الطلب التالي.
 * نحفظ النجاح فقط لا الوعد الجاري: انتظار وعد بدأه طلب آخر قد يعلق إن انتهى ذلك الطلب قبله.
 * تزامن طلبين عند البدء لا يضر، فـ applyMigrations يتحمّله.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (ready) return;
  const applied = await applyMigrations(db, MIGRATIONS);
  ready = true;
  if (applied.length) console.log(JSON.stringify({ evt: 'schema_migrated', applied }));
}
