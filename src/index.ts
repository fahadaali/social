// نقطة الدخول: fetch() لـ webhook تيليجرام، و scheduled() لمهام Cron (SPEC §2 و§4).

import { ownerChat, secretMatches, webhookSecret } from './auth.ts';
import { makeCtx, WEBHOOK_BUDGET_MS } from './context.ts';
import { markUpdateProcessed } from './db.ts';
import { ownerId, type Env } from './env.ts';
import { handleCallback } from './handlers/callbacks.ts';
import { errorSummary, runScheduled } from './handlers/cron.ts';
import { handleMessage } from './handlers/messages.ts';
import { ensureSchema } from './migrations.ts';
import { handleSetup } from './setup.ts';
import { sendMessage, type TgUpdate } from './telegram.ts';

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

  async scheduled(controller, env): Promise<void> {
    await runScheduled(env, controller.cron);
  },
} satisfies ExportedHandler<Env>;
