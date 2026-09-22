// أوامر المتابعة (SPEC §7): /queue و /usage و /pause و /resume.

import type { Ctx } from './context.ts';
import { deleteState, listDraftsByStatus, setState, STATE_KEYS, type Draft } from './db.ts';
import { isDryRun, monthlyPostLimit } from './env.ts';
import { CB, versionLabel } from './preview.ts';
import { computeCredits } from './publishing.ts';
import { getUsage, socialApiErrorMessage } from './socialapi.ts';
import { button, sendMessage, type InlineKeyboard } from './telegram.ts';
import { truncate } from './text.ts';
import { formatRiyadh, parseUtc } from './time.ts';

const QUEUE_LIMIT = 10;

const title = (d: Draft) => `«${truncate(d.x_segments[0] ?? d.linkedin_text, 70)}»`;

/** /queue: المسودات المعلّقة والمجدولة، مع زر «عرض» لكل مسودة معلّقة لاستعادة أزرارها. */
export async function showQueue(ctx: Ctx): Promise<void> {
  const db = ctx.env.DB;
  const scheduled = (await listDraftsByStatus(db, ['scheduled'], 50)).sort((a, b) =>
    (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''),
  );
  const pending = await listDraftsByStatus(db, ['pending', 'failed'], QUEUE_LIMIT, true);
  const publishing = await listDraftsByStatus(db, ['publishing'], QUEUE_LIMIT);

  if (scheduled.length + pending.length + publishing.length === 0) {
    await sendMessage(ctx.env, ctx.chatId, '📋 لا توجد مسودات معلّقة أو مجدولة. أرسل فكرة جديدة أو /ideas.');
    return;
  }

  const sections: string[] = ['📋 قائمة الانتظار'];
  if (scheduled.length) {
    const lines = scheduled.slice(0, QUEUE_LIMIT).map((d) => {
      const when = d.scheduled_at ? formatRiyadh(parseUtc(d.scheduled_at)) : 'موعد غير معروف';
      return `• #${d.id} — ${when} — ${title(d)}`;
    });
    sections.push(`🕒 المجدولة (${scheduled.length}):\n${lines.join('\n')}`);
  }
  if (pending.length) {
    const lines = pending.map((d) => `• #${d.id} (${versionLabel(d)})${d.status === 'failed' ? ' ⚠️ فشل نشرها' : ''} — ${title(d)}`);
    sections.push(`📝 المعلّقة (الأحدث أولاً):\n${lines.join('\n')}`);
  }
  if (publishing.length) {
    sections.push(`⏳ قيد النشر:\n${publishing.map((d) => `• #${d.id} — ${title(d)}`).join('\n')}`);
  }

  const buttons = pending.map((d) => button(`عرض #${d.id}`, CB.show(d.id)));
  const keyboard: InlineKeyboard = { inline_keyboard: [] };
  for (let i = 0; i < buttons.length; i += 3) keyboard.inline_keyboard.push(buttons.slice(i, i + 3));
  await sendMessage(ctx.env, ctx.chatId, sections.join('\n\n'), keyboard.inline_keyboard.length ? keyboard : undefined);
}

/** /usage: رصيد منشورات SocialAPI للفترة الحالية. */
export async function showUsage(ctx: Ctx): Promise<void> {
  let text: string;
  try {
    const c = computeCredits(await getUsage(ctx.env), monthlyPostLimit(ctx.env));
    const lines = ['📊 رصيد SocialAPI للفترة الحالية'];
    if (c.unlimited) lines.push(`المنشورات: غير محدود (استُخدم ${c.used ?? 0})`);
    else lines.push(`المنشورات: استُخدم ${c.used ?? 0} من ${c.limit} — المتبقي ${c.remaining}`);
    if (c.periodEnd) {
      const end = new Date(c.periodEnd);
      if (!Number.isNaN(end.getTime())) lines.push(`يتجدد الرصيد: ${formatRiyadh(end)} (بتوقيت الرياض)`);
    }
    if (!c.unlimited && c.remaining !== null && c.remaining <= 2) lines.push('⚠️ الرصيد يوشك على النفاد.');
    if (isDryRun(ctx.env)) lines.push('🧪 وضع التجربة مفعّل: المسودات لا تستهلك رصيداً.');
    text = lines.join('\n');
  } catch (err) {
    text = `تعذّر جلب الرصيد: ${socialApiErrorMessage(err)}`;
  }
  await sendMessage(ctx.env, ctx.chatId, text);
}

/** /pause و /resume: إيقاف تذكير الانقطاع اليومي واستئنافه (SPEC §9 ب). */
export async function setRemindersPaused(ctx: Ctx, paused: boolean): Promise<void> {
  if (paused) await setState(ctx.env.DB, STATE_KEYS.remindersPaused, '1');
  else await deleteState(ctx.env.DB, STATE_KEYS.remindersPaused);
  await sendMessage(
    ctx.env,
    ctx.chatId,
    paused
      ? '⏸ أوقفت تذكيرات انقطاع النشر. الخطة الأسبوعية وتقرير الأداء مستمران. أرسل /resume للاستئناف.'
      : '▶️ استؤنفت تذكيرات انقطاع النشر.',
  );
}
