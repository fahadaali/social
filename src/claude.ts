// Anthropic Messages API عبر fetch مباشرة، بمخرجات JSON مقيّدة بمخطط (structured outputs).
// SPEC §10: مخرجات JSON فقط، والتحقق منها، وإعادة المحاولة مرة واحدة عند فشل التحليل.
// SPEC §11: عند خطأ من Anthropic إعادة محاولة واحدة بعد ثانيتين ثم إبلاغ المستخدم.

import type { Env } from './env.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const RETRY_DELAY_MS = 2_000;
const SAFETY_MARGIN_MS = 2_500; // وقت نحتاجه بعد الاستدعاء لإبلاغ المستخدم قبل انتهاء المهلة
const MIN_ATTEMPT_MS = 6_000; // لا نبدأ محاولة لا يكفيها الوقت المتبقي
const MAX_ATTEMPT_MS = 60_000;

export type ClaudeErrorKind = 'timeout' | 'network' | 'http' | 'refusal' | 'invalid_output';

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  readonly status: number | undefined;

  constructor(kind: ClaudeErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    if (this.kind === 'http') return this.status === undefined || [408, 409, 429, 529].includes(this.status) || this.status >= 500;
    return this.kind !== 'refusal';
  }
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeJsonRequest<T> {
  model: string;
  system: string;
  /** تخزين تعليمات النظام مؤقتاً (prompt caching) عندما تتكرر بين الاستدعاءات. */
  cacheSystem?: boolean;
  messages: ClaudeMessage[];
  schema: Record<string, unknown>;
  maxTokens: number;
  /** لحظة (epoch ms) يجب أن ننتهي قبلها؛ تضبط مهلة كل محاولة وتحدد إن كانت إعادة المحاولة ممكنة. */
  deadline: number;
  /** تحويل الكائن المحلَّل والتحقق من بنيته؛ يرمي عند المخالفة فتُحتسب فشلاً في التحليل. */
  parse: (raw: unknown) => T;
  label: string;
}

/**
 * التفكير الموسّع يطيل زمن الاستجابة، والمهلة المتاحة داخل waitUntil قصيرة (SPEC §2)،
 * لذلك نوقفه صراحةً في Sonnet/Opus حيث يُقبل {type: "disabled"}، ونتركه للافتراضي في غيرها
 * (Haiku لا يفكر افتراضياً، وبعض النماذج الأحدث ترفض تعطيله).
 */
export function thinkingParams(model: string): Record<string, unknown> {
  if (/^claude-(sonnet|opus)-/.test(model) && !/^claude-opus-5-5/.test(model)) {
    return { thinking: { type: 'disabled' } };
  }
  return {};
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** كتلة من محتوى الرد كما تصل (نص، أو استدعاء أداة ونتائجها، أو تفكير). */
export type ContentBlock = { type: string } & Record<string, unknown>;

interface ApiResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  error?: { type?: string; message?: string };
}

/** طلب واحد إلى Messages API مع تحويل الأخطاء إلى ClaudeError وتسجيل الاستهلاك (بلا نصوص). */
async function post(env: Env, body: Record<string, unknown>, budget: number, label: string): Promise<ApiResponse> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new ClaudeError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', name || 'fetch failed');
  }

  let data: ApiResponse;
  try {
    data = await res.json();
  } catch {
    throw new ClaudeError(res.ok ? 'invalid_output' : 'http', 'invalid response body', res.ok ? undefined : res.status);
  }
  if (!res.ok) {
    // نوع الخطأ ونص Anthropic المختصر (لا يحوي المفتاح)، ليُعرف السبب في السجلات
    const detail = [data.error?.type, data.error?.message?.slice(0, 200)].filter(Boolean).join(': ');
    throw new ClaudeError('http', detail || `status ${res.status}`, res.status);
  }

  const searches = data.usage?.server_tool_use?.web_search_requests;
  console.log(
    JSON.stringify({
      evt: 'claude',
      label,
      model: body.model,
      ms: Date.now() - started,
      stop: data.stop_reason,
      in: data.usage?.input_tokens,
      out: data.usage?.output_tokens,
      cache_read: data.usage?.cache_read_input_tokens,
      cache_write: data.usage?.cache_creation_input_tokens,
      ...(searches !== undefined ? { searches } : {}),
    }),
  );
  return data;
}

async function attempt<T>(env: Env, req: ClaudeJsonRequest<T>): Promise<T> {
  const budget = Math.min(req.deadline - Date.now() - SAFETY_MARGIN_MS, MAX_ATTEMPT_MS);
  if (budget < MIN_ATTEMPT_MS) throw new ClaudeError('timeout', 'not enough time left');

  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [
      {
        type: 'text',
        text: req.system,
        ...(req.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}),
      },
    ],
    messages: req.messages,
    output_config: { format: { type: 'json_schema', schema: req.schema } },
    ...thinkingParams(req.model),
  };
  const data = await post(env, body, budget, req.label);

  if (data.stop_reason === 'refusal') throw new ClaudeError('refusal', 'model refused');
  if (data.stop_reason === 'max_tokens') throw new ClaudeError('invalid_output', 'output truncated (max_tokens)');

  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ClaudeError('invalid_output', 'output is not valid JSON');
  }
  try {
    return req.parse(raw);
  } catch (err) {
    throw new ClaudeError('invalid_output', `schema check failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

/** محاولة ثم إعادة واحدة إن سمح الوقت وكان الخطأ قابلاً لإعادة المحاولة. */
export async function claudeJson<T>(env: Env, req: ClaudeJsonRequest<T>): Promise<T> {
  try {
    return await attempt(env, req);
  } catch (err) {
    if (!(err instanceof ClaudeError) || !err.retryable) throw err;
    console.warn(JSON.stringify({ evt: 'claude_retry', label: req.label, kind: err.kind, status: err.status }));
    // فشل التحليل يُعاد فوراً؛ أخطاء الخدمة بعد ثانيتين
    const delay = err.kind === 'invalid_output' ? 0 : RETRY_DELAY_MS;
    if (req.deadline - Date.now() - delay - SAFETY_MARGIN_MS < MIN_ATTEMPT_MS) throw err;
    if (delay) await sleep(delay);
    return attempt(env, req);
  }
}

// ---------- البحث في الويب (NOTES.md القسم 11) ----------

export interface ClaudeSearchRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** أداة البحث كما تُرسل للـ API (web_search). */
  tool: Record<string, unknown>;
  deadline: number;
  label: string;
}

const MAX_SEARCH_ATTEMPT_MS = 180_000;
const MAX_PAUSES = 3;

/**
 * مع الأدوات يبقى التفكير المتكيّف مفعّلاً بجهد متوسط: تعطيله قد يجعل النموذج يكتب طلب البحث نصاً
 * بدل استدعاء الأداة. Haiku لا يدعم التفكير المتكيّف ولا مستوى الجهد، فيُترك على افتراضه.
 */
function searchReasoning(model: string): Record<string, unknown> {
  if (/^claude-haiku-/.test(model)) return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } };
}

async function searchAttempt(env: Env, req: ClaudeSearchRequest): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (let pauses = 0; ; pauses++) {
    const budget = Math.min(req.deadline - Date.now() - SAFETY_MARGIN_MS, MAX_SEARCH_ATTEMPT_MS);
    if (budget < MIN_ATTEMPT_MS) throw new ClaudeError('timeout', 'not enough time left');
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }, ...(blocks.length ? [{ role: 'assistant', content: blocks }] : [])],
      tools: [req.tool],
      ...searchReasoning(req.model),
    };
    const data = await post(env, body, budget, req.label);
    if (data.stop_reason === 'refusal') throw new ClaudeError('refusal', 'model refused');
    blocks.push(...(Array.isArray(data.content) ? data.content : []));
    // بحث طويل قد يتوقف مؤقتاً (pause_turn): تُعاد الإجابة كما هي فيكمل من حيث توقف
    if (data.stop_reason !== 'pause_turn') return blocks;
    if (pauses >= MAX_PAUSES) throw new ClaudeError('timeout', 'search did not finish');
  }
}

/** بحث في الويب بإجابة نصية مسنَدة (بلا مخطط JSON: المصادر لا تجتمع مع المخرجات المقيّدة). */
export async function claudeSearch(env: Env, req: ClaudeSearchRequest): Promise<ContentBlock[]> {
  try {
    return await searchAttempt(env, req);
  } catch (err) {
    if (!(err instanceof ClaudeError) || !err.retryable || err.kind === 'invalid_output') throw err;
    console.warn(JSON.stringify({ evt: 'claude_retry', label: req.label, kind: err.kind, status: err.status }));
    if (req.deadline - Date.now() - RETRY_DELAY_MS - SAFETY_MARGIN_MS < MIN_ATTEMPT_MS) throw err;
    await sleep(RETRY_DELAY_MS);
    return searchAttempt(env, req);
  }
}

/** رسالة مختصرة للمستخدم بلا تفاصيل حساسة (SPEC §11). */
export function claudeErrorMessage(err: unknown): string {
  if (err instanceof ClaudeError) {
    switch (err.kind) {
      case 'timeout':
        return 'استغرقت الصياغة وقتاً أطول من المسموح.';
      case 'refusal':
        return 'اعتذر Claude عن تنفيذ هذا الطلب.';
      case 'invalid_output':
        return 'أعاد Claude ردّاً غير صالح.';
      case 'http':
        if (err.status === 401 || err.status === 403) return 'مفتاح Anthropic غير صالح أو لا يملك صلاحية.';
        if (err.status === 400 || err.status === 404) return 'رفضت Anthropic الطلب (راجع اسم النموذج في الإعدادات).';
        if (err.status === 429 || err.status === 529) return 'خدمة Claude مشغولة الآن.';
        return 'تعذّر الاتصال بخدمة Claude.';
      case 'network':
        return 'تعذّر الاتصال بخدمة Claude.';
    }
  }
  return 'حدث خطأ غير متوقع أثناء الصياغة.';
}
