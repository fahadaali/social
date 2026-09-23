// تطبيق ترحيلات D1 من داخل الـ Worker نفسه، فلا يحتاج النشر من GitHub إلى خطوة
// «wrangler d1 migrations apply» ولا إلى رمز API بصلاحية D1 (NOTES.md القسم 10).
// يستخدم جدول d1_migrations بصيغة Wrangler نفسها، فالطريقتان متوافقتان: ما طبّقه أحدهما يعرفه الآخر.

export interface Migration {
  name: string;
  sql: string;
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** يحذف تعليقات «--» ويقسم ملف الترحيل إلى جمل. ملفاتنا لا تحوي «;» ولا «--» داخل نص بين علامتي تنصيص. */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * يطبّق الترحيلات غير المطبّقة بالترتيب. كل ترحيل يُنفَّذ مع تسجيله في دفعة واحدة (معاملة ذرّية):
 * إما أن يُطبَّق ويُسجَّل معاً، أو لا شيء. إن سبقه Worker آخر إليه (بدء متزامن) يُكتفى بتسجيله.
 * يعيد أسماء ما طُبّق.
 */
export async function applyMigrations(db: D1Database, migrations: readonly Migration[]): Promise<string[]> {
  await db.prepare(CREATE_MIGRATIONS_TABLE).run();
  const rows = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const done = new Set(rows.results.map((r) => r.name));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const statements = splitSql(m.sql).map((s) => db.prepare(s));
    statements.push(db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name));
    try {
      await db.batch(statements);
      applied.push(m.name);
    } catch (err) {
      const again = await db.prepare('SELECT 1 AS ok FROM d1_migrations WHERE name = ?').bind(m.name).first();
      if (!again) throw err;
    }
  }
  return applied;
}
