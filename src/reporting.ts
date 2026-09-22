// تقرير الأداء: /stats الآن، والتقرير الأسبوعي يوم الخميس (SPEC §9 و§10 report).

import { collectPerformance, pillarStats, REPORT_WINDOW_DAYS, saveSnapshot } from './analytics.ts';
import { ClaudeError, claudeErrorMessage, claudeJson } from './claude.ts';
import { PILLARS_MD } from './content.ts';
import type { Ctx } from './context.ts';
import { draftModel } from './env.ts';
import { CB, retryKeyboard } from './preview.ts';
import { LOW_DATA_THRESHOLD, parseReport, REPORT_MAX_TOKENS, REPORT_SCHEMA, reportSystem, reportUser } from './prompts/report.ts';
import { socialApiErrorMessage } from './socialapi.ts';
import { editMessageText, sendMessage } from './telegram.ts';
import { postsAr } from './text.ts';
import { formatRiyadhDate } from './time.ts';

const HEADER = `📈 تقرير الأداء (آخر ${REPORT_WINDOW_DAYS} يوماً)`;

/** يجمع المقاييس ويحفظ لقطتها ثم يكتب التقرير. رسالة قصيرة جاهزة للإرسال. */
export async function buildReport(ctx: Ctx): Promise<string> {
  const items = await collectPerformance(ctx);
  await saveSnapshot(ctx.env.DB, items);

  if (items.length === 0) {
    return `${HEADER}\n\nلم يُنشر شيء عبر البوت خلال هذه الفترة، فلا أرقام يُبنى عليها تقرير.`;
  }
  const measured = items.filter((i) => i.total !== null);
  if (measured.length === 0) {
    return `${HEADER}\n\nنُشر ${postsAr(items.length)} خلال الفترة، لكن SocialAPI لم تُرجع لها مقاييس بعد، فلا أستنتج شيئاً.`;
  }

  const report = await claudeJson(ctx.env, {
    model: draftModel(ctx.env),
    system: reportSystem(PILLARS_MD),
    messages: [{ role: 'user', content: reportUser(formatRiyadhDate(new Date()), items, pillarStats(items)) }],
    schema: REPORT_SCHEMA,
    maxTokens: REPORT_MAX_TOKENS,
    deadline: ctx.deadline,
    parse: parseReport,
    label: 'report',
  });

  return [
    HEADER,
    report.headline,
    `🏆 ${report.top_post}`,
    `💡 ${report.insight}`,
    `➡️ للأسبوع القادم: ${report.next_week_tip}`,
    `— البيانات: ${postsAr(items.length)}، منها ${measured.length} بمقاييس متاحة.`,
    measured.length < LOW_DATA_THRESHOLD ? 'ℹ️ البيانات قليلة، فالاستنتاجات مبدئية.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** /stats: تقرير الأداء الآن. */
export async function runStats(ctx: Ctx): Promise<void> {
  const placeholder = await sendMessage(ctx.env, ctx.chatId, '⏳ أجمع مقاييس المنشورات…');
  try {
    await editMessageText(ctx.env, ctx.chatId, placeholder.message_id, await buildReport(ctx));
  } catch (err) {
    console.error(JSON.stringify({ evt: 'stats_failed', err: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' }));
    const reason = err instanceof ClaudeError ? claudeErrorMessage(err) : socialApiErrorMessage(err);
    await editMessageText(
      ctx.env,
      ctx.chatId,
      placeholder.message_id,
      `❌ تعذّر إعداد التقرير: ${reason}`,
      retryKeyboard(CB.retry('s', 0)),
    );
  }
}
