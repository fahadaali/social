// /export: نسخة احتياطية من الأفكار والمسودات تصل المالك ملفاً (JSON) في محادثته.
// الملف فيه النصوص كاملة، فلا يُسجَّل منه شيء سوى الأعداد.

import type { Ctx } from './context.ts';
import { allDrafts, allIdeas } from './db.ts';
import { sendDocument } from './telegram.ts';
import { formatRiyadhDate, riyadhParts } from './time.ts';

export const BACKUP_FORMAT = 'social-backup/1';

const pad = (n: number) => String(n).padStart(2, '0');

export async function exportBackup(ctx: Ctx): Promise<void> {
  const db = ctx.env.DB;
  const [ideas, drafts] = await Promise.all([allIdeas(db), allDrafts(db)]);
  const now = new Date();
  const p = riyadhParts(now);
  const payload = { format: BACKUP_FORMAT, exported_at: now.toISOString(), ideas, drafts };
  const caption = [
    `💾 نسخة احتياطية حتى ${formatRiyadhDate(now)}`,
    `الأفكار: ${ideas.length} — المسودات: ${drafts.length}`,
    'احفظ الملف في مكان آمن: فيه نصوصك كاملة.',
  ].join('\n');
  await sendDocument(
    ctx.env,
    ctx.chatId,
    `social-backup-${p.year}-${pad(p.month)}-${pad(p.day)}.json`,
    JSON.stringify(payload, null, 2),
    'application/json',
    caption,
  );
  console.log(JSON.stringify({ evt: 'backup_exported', ideas: ideas.length, drafts: drafts.length }));
}
