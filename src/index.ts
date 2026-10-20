// نقطة الدخول: fetch() لـ webhook تيليجرام، و scheduled() لمهام Cron (SPEC §2 و§4).

import { ownerChat, secretMatches, webhookSecret } from './auth.ts';
import { makeCtx, QUEUE_BUDGET_MS, WEBHOOK_BUDGET_MS } from './context.ts';
import { markUpdateProcessed } from './db.ts';
import { draftJobRetry, runDraftJob, type DraftJob } from './drafting.ts';
import { ownerId, type Env } from './env.ts';
import { handleCallback } from './handlers/callbacks.ts';
import { errorSummary, runScheduled } from './handlers/cron.ts';
import { handleMessage } from './handlers/messages.ts';
import { ensureSchema } from './migrations.ts';
import { withSavedMode } from './mode.ts';
import { handleSetup } from './setup.ts';
import { editMessageText, sendMessage, type TgUpdate } from './telegram.ts';
import { retryKeyboard } from './preview.ts';

const WEBHOOK_PATH = '/webhook';

const ok = () => new Response('ok');

async function processUpdate(env: Env, update: TgUpdate, chatId: number): Promise<void> {
  const ctx = makeCtx(env, chatId, WEBHOOK_BUDGET_MS);
  try {
    if (!env.DB) {
      await sendMessage(env, chatId, '⚠️ قاعدة البيانات غير مربوطة بالـ Worker بعد. افتح صفحة /setup في رابط الـ Worker لمعرفة المطلوب.');
      return;
    }
    await ensureSchema(env.DB);
    ctx.env = await withSavedMode(env);
    // منع التكرار (SPEC §4.3)
    if (!(await markUpdateProcessed(env.DB, update.update_id))) return;
    if (update.message) await handleMessage(ctx, update.message);
    else if (update.callback_query) await handleCallback(ctx, update.callback_query);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'update_failed',
        update: update.update_id,
        err: err instanceof Error ? err.name : 'unknown',
        summary: errorSummary(err),
      }),
    );
    try {
      await sendMessage(env, chatId, 'حدث خطأ غير متوقع. حاول مرة أخرى.');
    } catch {
      // لا شيء آخر يمكن فعله
    }
  }
}

/**
 * مستهلك طابور الصياغة (NOTES.md القسم 3). لا يُعاد العمل نفسه إن انقطع تنفيذه (تجاوز المهلة مثلاً)،
 * حتى لا تُنشأ مسودة مكررة: المحاولة الثانية تُبلغ المالك فقط وتعرض زر إعادة المحاولة.
 */
async function processDraftJob(env: Env, job: DraftJob, attempts: number): Promise<void> {
  // احتياط: الطابور لا يملؤه إلا الـ Worker نفسه، ولمحادثة المالك وحده
  if (String(job.chatId) !== ownerId(env)) return;
  const ctx = makeCtx(env, job.chatId, QUEUE_BUDGET_MS);
  try {
    if (attempts > 1) {
      console.warn(JSON.stringify({ evt: 'draft_job_interrupted', kind: job.kind, attempts }));
      await editMessageText(env, job.chatId, job.placeholderId, '❌ انقطعت الصياغة قبل أن تكتمل.', retryKeyboard(draftJobRetry(job)));
      return;
    }
    await ensureSchema(env.DB);
    ctx.env = await withSavedMode(env);
    await runDraftJob(ctx, job);
  } catch (err) {
    // runDraftJob لا يرمي؛ هذا فشل قبله (قاعدة البيانات مثلاً)، فلا تبقى رسالة «جاري الصياغة…» معلّقة
    console.error(JSON.stringify({ evt: 'draft_job_failed', kind: job.kind, summary: errorSummary(err) }));
    try {
      await editMessageText(env, job.chatId, job.placeholderId, '❌ تعذّرت الصياغة: حدث خطأ غير متوقع.', retryKeyboard(draftJobRetry(job)));
    } catch {
      // لا شيء آخر يمكن فعله
    }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return ok();
    if (url.pathname === '/setup' && request.method === 'GET') return handleSetup(request, env);
    if (url.pathname !== WEBHOOK_PATH) return new Response('not found', { status: 404 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const secret = await webhookSecret(env);
    if (!secretMatches(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), secret ?? undefined)) {
      return new Response('unauthorized', { status: 401 });
    }

    let update: TgUpdate;
    try {
      update = await request.json();
    } catch {
      return ok();
    }
    if (typeof update?.update_id !== 'number') return ok();

    const chatId = ownerChat(update, ownerId(env));
    if (chatId === null) return ok(); // غير المالك: تجاهل صامت بلا أي رد

    // نرد على تيليجرام فوراً بـ 200 ونكمل العمل في الخلفية (SPEC §2)
    ctx.waitUntil(processUpdate(env, update, chatId));
    return ok();
  },

  async queue(batch, env): Promise<void> {
    for (const msg of batch.messages) {
      // زمن الانتظار في الطابور، ليُعرف من السجلات إن كان يؤخّر الصياغة
      console.log(JSON.stringify({ evt: 'draft_job', kind: msg.body.kind, wait_ms: Date.now() - msg.timestamp.getTime(), attempts: msg.attempts }));
      await processDraftJob(env, msg.body, msg.attempts);
      msg.ack();
    }
  },

  async scheduled(controller, env): Promise<void> {
    await runScheduled(env, controller.cron);
  },
} satisfies ExportedHandler<Env, DraftJob>;
