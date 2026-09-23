// تشغيل الـ Worker المجمّع فعلياً داخل workerd (Miniflare) مع قاعدة D1 محلية،
// واعتراض كل طلبات الشبكة الخارجة (Telegram / Anthropic / SocialAPI) بخوادم وهمية.
// لا يصل أي طلب إلى الإنترنت أثناء الاختبار.

import { readdirSync, readFileSync } from 'node:fs';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

export const OWNER = 111111;
export const STRANGER = 222222;
export const SECRET = 'e2e_secret-TOKEN_0123456789';
export const BOT_TOKEN = '123456:TEST-bot-token';

// ربط Workers AI (env.AI) لا يعمل محلياً دون حساب؛ نحاكيه بعامل ثانٍ يعرض run() عبر RPC
// ويمرر الطلب إلى الخادم الوهمي في Node ليُسجَّل ويُرد عليه.
const AI_MOCK_SCRIPT = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export default class AiMock extends WorkerEntrypoint {
  async run(model, inputs) {
    const audio = inputs && typeof inputs.audio === 'string' ? { base64: inputs.audio } : inputs.audio;
    const res = await fetch('https://ai.mock/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, inputs: { ...inputs, audio } }),
    });
    const data = await res.json();
    if (data && data.__error) throw new Error(data.__error);
    return data;
  }
  async fetch() { return new Response('ai mock'); }
}`;

const ROOT = new URL('../../', import.meta.url);
const BUILD_DIR = new URL('.build', ROOT).pathname; // ناتج: npm run build:check

// ---------- ردود Anthropic الافتراضية ----------

export function draftOutput(over = {}) {
  return {
    x_segments: ['الحوكمة ليست أوراقاً تُحفظ، بل قرارات تُتخذ في وقتها.', 'ثلاث خطوات عملية لبدء الحوكمة في منظمتك.', 'ابدأ بمصفوفة صلاحيات واضحة.'],
    linkedin_text: Array.from({ length: 150 }, (_, i) => (i % 12 === 11 ? 'الحوكمة.\n' : 'كلمة')).join(' '),
    snap_script: ['الحوكمة قرار\nلا ورقة', 'ثلاث خطوات', 'ابدأ اليوم'],
    needs_visual: true,
    visual_brief: 'بطاقة تلخّص الخطوات الثلاث',
    notes: null,
    ...over,
  };
}

function schemaKind(body) {
  const props = body?.output_config?.format?.schema?.properties ?? {};
  if ('x_segments' in props) return 'draft';
  if ('suggestions' in props) return 'plan';
  if ('headline' in props) return 'report';
  if ('summary' in props) return 'classify';
  return 'unknown';
}

function defaultAnthropic(body, kind) {
  if (kind === 'classify') {
    const allowed = body.output_config.format.schema.properties.pillar.enum;
    return { pillar: allowed ? allowed[0] : 'الحوكمة', summary: 'ملخص قصير للفكرة' };
  }
  if (kind === 'plan') {
    return { suggestions: [{ idea_id: null, pillar: 'الحوكمة', angle: 'زاوية جديدة عن اللجان', why_now: 'توازن المحاور' }] };
  }
  if (kind === 'report') {
    return {
      headline: 'أسبوع هادئ بتفاعل محدود',
      top_post: 'المنشور #1 تصدّر بمجموع 18',
      insight: 'التفاعل على X أعلى من لينكدن في هذه الفترة',
      next_week_tip: 'انشر منشورين على الأقل لتتضح الصورة',
    };
  }
  return draftOutput();
}

export function anthropicMessage(obj, stop = 'end_turn') {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'mock',
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

// ---------- الخادم الوهمي ----------

export async function startBot({ vars = {} } = {}) {
  const calls = [];
  const mocks = {
    // (body, kind, n) => {status, json} | object (يُلف كرسالة ناجحة)
    anthropic: [],
    usage: { posts_used: 4, posts_limit: 10, period_end: '2026-10-15T00:00:00Z' },
    validate: { valid: true, errors: [], warnings: [] },
    createPost: null, // (body) => {status, json}
    getPost: null, // (id) => {status, json}
    patchPost: null, // (id, body) => {status, json}
    deletePost: null, // (id) => {status, json}؛ الافتراضي يحذف فيصير GET للمعرّف 404
    retryPost: null, // (id) => {status, json}
    metrics: null, // (id) => {status, json}
    upload: { status: 201, json: { media_id: 'med_1' } },
    // (inputs) => رد النموذج، أو { __error: 'رسالة' } لرمي خطأ
    ai: null,
    // حاجز: يحبس ردود answerCallbackQuery حتى يصل هذا العدد منها ثم يطلقها معاً (لاختبار السباق)
    answerBarrier: 0,
    // (method, body) => true لإفشال طلب تيليجرام بعينه
    tgFail: null,
  };
  let waiting = [];
  let messageId = 1000;
  let postSeq = 0;
  const deleted = new Set();

  const json = (status, data) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function outbound(request) {
    const url = new URL(request.url);
    const call = { host: url.hostname, method: request.method, path: url.pathname, url: request.url };
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) call.body = await request.json();
    else if (ct.includes('multipart/form-data')) {
      // الحقول النصية كما هي، والملفات بالاسم والنوع والحجم (ونصها إن كانت JSON أو نصاً)
      const form = await request.formData();
      call.form = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') {
          call.form[key] = value;
          continue;
        }
        call.form[key] = { name: value.name, type: value.type, size: value.size };
        if (/json|text/.test(value.type)) call.form[key].text = await value.text();
      }
    }
    call.headers = Object.fromEntries(request.headers);
    calls.push(call);

    if (url.hostname === 'api.telegram.org') {
      if (url.pathname.startsWith('/file/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
      const method = url.pathname.split('/').pop();
      call.tg = method;
      if (mocks.tgFail?.(method, call.body)) {
        return json(500, { ok: false, error_code: 500, description: 'Internal Server Error' });
      }
      if (method === 'sendMessage') {
        return json(200, { ok: true, result: { message_id: ++messageId, date: 1, chat: { id: call.body.chat_id, type: 'private' }, text: call.body.text } });
      }
      if (method === 'answerCallbackQuery' && mocks.answerBarrier > 0) {
        await new Promise((resolve) => {
          waiting.push(resolve);
          if (waiting.length >= mocks.answerBarrier) {
            waiting.forEach((r) => r());
            waiting = [];
            mocks.answerBarrier = 0;
          }
        });
      }
      if (method === 'getFile') return json(200, { ok: true, result: { file_id: call.body.file_id, file_path: 'photos/file_7.jpg', file_size: 6 } });
      return json(200, { ok: true, result: true });
    }

    if (url.hostname === 'ai.mock') {
      call.ai = call.body;
      const out = mocks.ai ? mocks.ai(call.body.inputs, call.body.model) : { text: 'فكرة صوتية: مجالس الإدارة تحتاج مصفوفة صلاحيات واضحة' };
      return json(200, out);
    }

    if (url.hostname === 'api.anthropic.com') {
      const kind = schemaKind(call.body);
      call.kind = kind;
      const n = calls.filter((c) => c.kind === kind).length;
      const custom = mocks.anthropic.shift();
      const out = custom ? custom(call.body, kind, n) : defaultAnthropic(call.body, kind);
      if (out && typeof out.status === 'number') return json(out.status, out.json);
      return json(200, anthropicMessage(out));
    }

    if (url.hostname === 'api.social-api.ai') {
      const p = url.pathname;
      if (p === '/v1/usage' && request.method === 'GET') {
        if (mocks.usageError) return json(401, { error: { code: 'auth.invalid_key', message: 'bad key' } });
        return json(200, mocks.usage);
      }
      if (p === '/v1/posts/validate' && request.method === 'POST') return json(200, mocks.validate);
      if (p === '/v1/media/upload' && request.method === 'POST') return json(mocks.upload.status, mocks.upload.json);
      if (p === '/v1/posts' && request.method === 'POST') {
        if (mocks.createPost) {
          const r = mocks.createPost(call.body);
          return json(r.status, r.json);
        }
        const status = call.body.publish_now ? 'publishing' : call.body.scheduled_at ? 'scheduled' : 'draft';
        return json(201, { id: `p_${++postSeq}`, status, scheduled_at: call.body.scheduled_at, targets: [] });
      }
      const mm = /^\/v1\/posts\/([^/]+)\/metrics$/.exec(p);
      if (mm && request.method === 'GET') {
        if (mocks.metrics) {
          const r = mocks.metrics(mm[1]);
          return json(r.status, r.json);
        }
        return json(200, {
          data: {
            post_id: mm[1],
            targets: [
              { platform: 'twitter', status: 'published', metrics: { likes: 12, comments: 3, shares: 2, saves: 1 } },
              { platform: 'linkedin', status: 'published' },
            ],
          },
        });
      }
      const rm = /^\/v1\/posts\/([^/]+)\/retry$/.exec(p);
      if (rm && request.method === 'POST') {
        if (mocks.retryPost) {
          const r = mocks.retryPost(rm[1]);
          return json(r.status, r.json);
        }
        return json(200, { success: true });
      }
      const m = /^\/v1\/posts\/([^/]+)$/.exec(p);
      if (m && request.method === 'PATCH') {
        if (mocks.patchPost) {
          const r = mocks.patchPost(m[1], call.body);
          return json(r.status, r.json);
        }
        return json(200, { id: m[1], status: 'scheduled', scheduled_at: call.body.scheduled_at, targets: [] });
      }
      if (m && request.method === 'DELETE') {
        if (mocks.deletePost) {
          const r = mocks.deletePost(m[1]);
          return json(r.status, r.json);
        }
        deleted.add(m[1]);
        return json(200, { deleted: true, success: true, results: [] });
      }
      if (m && request.method === 'GET') {
        if (deleted.has(m[1])) return json(404, { error: { code: 'post.not_found', message: 'Post not found' } });
        if (mocks.getPost) {
          const r = mocks.getPost(m[1]);
          return json(r.status, r.json);
        }
        return json(200, {
          id: m[1],
          status: 'published',
          published_at: new Date().toISOString(),
          targets: [
            { platform: 'twitter', status: 'published', permalink: 'https://x.com/owner/status/1' },
            { platform: 'linkedin', status: 'published', permalink: 'https://www.linkedin.com/feed/update/urn:li:share:1' },
          ],
        });
      }
    }
    return new Response('unexpected outbound request in test', { status: 599 });
  }

  const bindings = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ANTHROPIC_API_KEY: 'sk-ant-test',
    SOCIALAPI_KEY: 'sapi_key_test',
    ALLOWED_TELEGRAM_USER_ID: String(OWNER),
    SOCIALAPI_X_ACCOUNT_ID: 'acc_x',
    SOCIALAPI_LINKEDIN_ACCOUNT_ID: 'acc_li',
    CLAUDE_MODEL: 'claude-sonnet-5',
    CLAUDE_MODEL_FAST: 'claude-haiku-4-5-20251001',
    REMINDER_AFTER_DAYS: '4',
    MONTHLY_POST_LIMIT: '10',
    DRY_RUN: 'true',
    ...vars,
  };

  const workerLogs = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.NONE),
      handleStructuredLogs: (log) => workerLogs.push(log),
      workers: [
        {
          name: 'bot',
          modulesRoot: BUILD_DIR,
          modules: [
            { type: 'ESModule', path: `${BUILD_DIR}/index.js` },
            ...readdirSync(BUILD_DIR)
              .filter((f) => f.endsWith('.md') && f !== 'README.md')
              .map((f) => ({ type: 'Text', path: `${BUILD_DIR}/${f}` })),
          ],
          compatibilityDate: '2026-09-15',
          bindings,
          d1Databases: { DB: 'e2e-db' },
          serviceBindings: { AI: 'ai-mock' },
          outboundService: outbound,
        },
        {
          name: 'ai-mock',
          modules: true,
          script: AI_MOCK_SCRIPT,
          compatibilityDate: '2026-09-15',
          outboundService: outbound,
        },
      ],
    }),
  );
  await mf.ready;

  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(new URL('migrations/', ROOT)).sort()) {
    const sql = readFileSync(new URL(`migrations/${file}`, ROOT), 'utf8')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }

  let updateId = 1;
  const bot = {
    mf,
    db,
    calls,
    mocks,
    workerLogs,
    tg: (method) => calls.filter((c) => c.tg === method),
    lastTg: (method) => calls.filter((c) => c.tg === method).at(-1),
    social: (method, path) => calls.filter((c) => c.host === 'api.social-api.ai' && c.method === method && (!path || c.path === path)),
    anthropic: (kind) => calls.filter((c) => c.host === 'api.anthropic.com' && (!kind || c.kind === kind)),

    async post(update, headers = { 'X-Telegram-Bot-Api-Secret-Token': SECRET }) {
      return mf.dispatchFetch('https://bot.example/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(update),
      });
    },
    nextUpdateId: () => ++updateId,
    async sendText(text, from = OWNER) {
      return bot.post({
        update_id: ++updateId,
        message: { message_id: ++messageId, date: 1, from: { id: from, is_bot: false }, chat: { id: from, type: 'private' }, text },
      });
    },
    async sendVoice({ duration = 12, fileSize = 6, from = OWNER, asAudio = false } = {}) {
      const file = { file_id: 'voice_1', duration, mime_type: asAudio ? 'audio/mpeg' : 'audio/ogg', file_size: fileSize };
      return bot.post({
        update_id: ++updateId,
        message: { message_id: ++messageId, date: 1, from: { id: from }, chat: { id: from, type: 'private' }, ...(asAudio ? { audio: file } : { voice: file }) },
      });
    },
    ai: () => calls.filter((c) => c.host === 'ai.mock'),
    async sendPhoto({ caption, from = OWNER, asDocument = false } = {}) {
      const media = asDocument
        ? { document: { file_id: 'doc_1', file_name: 'design.png', mime_type: 'image/png', file_size: 6 } }
        : { photo: [{ file_id: 'small', width: 90, height: 90, file_size: 1 }, { file_id: 'large', width: 1280, height: 1280, file_size: 6 }] };
      return bot.post({
        update_id: ++updateId,
        message: { message_id: ++messageId, date: 1, from: { id: from }, chat: { id: from, type: 'private' }, ...(caption ? { caption } : {}), ...media },
      });
    },
    async press(data, { messageId: mid = 1, from = OWNER, markup } = {}) {
      const message = { message_id: mid, date: 1, chat: { id: from, type: 'private' }, ...(markup ? { reply_markup: markup } : {}) };
      return bot.post({
        update_id: ++updateId,
        callback_query: { id: `cq${updateId}`, from: { id: from }, data, message },
      });
    },
    /** ردود answerCallbackQuery (نص التنبيه وهل هو نافذة). */
    answers: () => calls.filter((c) => c.tg === 'answerCallbackQuery').map((c) => c.body),
    /** ينتظر حتى يتحقق الشرط على سجل الطلبات الخارجة. */
    async waitFor(pred, timeout = 15_000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const v = pred();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out waiting for ${label}; calls: ${JSON.stringify(calls.map((c) => c.tg ?? `${c.method} ${c.path}`))}`);
    },
    /** ينتظر هدوء الطلبات الخارجة (انتهاء عمل الخلفية). */
    async settle(quietMs = 400, timeout = 20_000) {
      const start = Date.now();
      let last = calls.length;
      let since = Date.now();
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 25));
        if (calls.length !== last) {
          last = calls.length;
          since = Date.now();
        } else if (Date.now() - since >= quietMs) return;
      }
    },
    /** الأزرار في آخر رسالة/تعديل يحمل لوحة أزرار. */
    lastKeyboard() {
      const withKb = calls.filter((c) => c.body?.reply_markup?.inline_keyboard?.length);
      return withKb.at(-1)?.body.reply_markup.inline_keyboard.flat() ?? [];
    },
    button(textPart) {
      const b = bot.lastKeyboard().find((x) => x.text.includes(textPart));
      if (!b) throw new Error(`button "${textPart}" not found in ${JSON.stringify(bot.lastKeyboard().map((x) => x.text))}`);
      return b.callback_data;
    },
    texts: () => calls.filter((c) => c.tg === 'sendMessage' || c.tg === 'editMessageText').map((c) => c.body.text),
    async row(sql, ...params) {
      return db.prepare(sql).bind(...params).first();
    },
    /**
     * ينتظر حتى يتحقق شرط على صف في D1. بعض الكتابات تلي آخر طلب خارجي (مثل نقل الأزرار الحيّة
     * بعد تعديل الرسالة)، فرؤية الطلب في السجل لا تعني أن الكتابة تمت.
     */
    async waitForRow(sql, params, pred, label = 'row', timeout = 5000) {
      const start = Date.now();
      let row;
      while (Date.now() - start < timeout) {
        row = await db.prepare(sql).bind(...params).first();
        if (row && pred(row)) return row;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out waiting for ${label}; last row: ${JSON.stringify(row)}`);
    },
    async scheduled(cron = '0 6 * * *') {
      const worker = await mf.getWorker();
      return worker.scheduled({ cron, scheduledTime: new Date() });
    },
    async dispose() {
      await mf.dispose();
    },
  };
  return bot;
}
