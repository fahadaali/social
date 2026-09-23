// SocialAPI.ai عبر fetch مباشرة. المرجع: api-reference/openapi.json في التوثيق الرسمي
// (مصدره github.com/SocialAPI-AI/docs) — انظر NOTES.md للتفاصيل والانحرافات عن SPEC.

import { accountId, PLATFORM_LABEL, type Env, type Platform } from './env.ts';

const BASE_URL = 'https://api.social-api.ai/v1';

// ---------- الأنواع (من مخطط OpenAPI) ----------

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

export interface MediaInput {
  source: string;
  source_type: 'url' | 'media_id' | 'platform_attachment_id';
  type?: 'image' | 'video' | 'audio' | 'file';
}

export interface TargetRequest {
  account_id: string;
  text?: string;
  media?: MediaInput[];
  platform_data?: Record<string, unknown>;
}

export interface CreatePostRequest {
  text?: string;
  targets: TargetRequest[];
  publish_now?: boolean;
  scheduled_at?: string;
}

export interface ValidatePostRequest {
  text?: string;
  targets: TargetRequest[];
  account_ids: string[];
  scheduled_at?: string;
}

export interface TargetError {
  category?: string;
  caused_by?: string;
  code?: string;
  message?: string;
}

export interface TargetMetrics {
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  extra?: Record<string, unknown>;
  // تسمية بديلة تظهر في أمثلة guides/concepts ووصف أدوات MCP الرسمية
  like_count?: number;
  comments_count?: number;
  shares_count?: number;
  saves_count?: number;
}

export interface PostTarget {
  account_id?: string;
  platform?: string;
  status?: string;
  permalink?: string;
  platform_post_id?: string;
  published_at?: string;
  scheduled_at?: string;
  error?: TargetError;
  metrics?: TargetMetrics;
  metrics_synced_at?: string;
}

export interface Post {
  id: string;
  status: PostStatus;
  scheduled_at?: string;
  published_at?: string;
  targets?: PostTarget[];
}

export interface Usage {
  posts_used?: number;
  posts_limit?: number;
  period_start?: string;
  period_end?: string;
}

export interface ValidationIssue {
  field?: string;
  message?: string;
  platform?: string;
  segment_index?: number;
  target?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export class SocialApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly apiMessage: string;
  readonly meta: Record<string, unknown>;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, apiMessage: string, meta: Record<string, unknown> = {}, requestId?: string) {
    super(`socialapi ${status} ${code}`);
    this.name = 'SocialApiError';
    this.status = status;
    this.code = code;
    this.apiMessage = apiMessage;
    this.meta = meta;
    this.requestId = requestId;
  }
}

// ---------- النقل ----------

interface RawResponse {
  status: number;
  data: unknown;
}

async function send(env: Env, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<RawResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.SOCIALAPI_KEY}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body; // يضبط fetch الـ boundary تلقائياً
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new SocialApiError(0, name === 'TimeoutError' ? 'network.timeout' : 'network.error', name || 'fetch failed');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, data };
}

function toError(r: RawResponse): SocialApiError {
  const env = (r.data ?? {}) as { error?: { code?: string; message?: string; meta?: Record<string, unknown> }; request_id?: string };
  return new SocialApiError(
    r.status,
    env.error?.code ?? `http.${r.status}`,
    env.error?.message ?? '',
    env.error?.meta ?? {},
    env.request_id,
  );
}

async function json<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const r = await send(env, method, path, body);
  if (r.status < 200 || r.status >= 300) throw toError(r);
  return r.data as T;
}

// ---------- العمليات ----------

/** GET /usage — الاستهلاك والحدود للفترة الحالية (-1 = غير محدود). */
export function getUsage(env: Env): Promise<Usage> {
  return json<Usage>(env, 'GET', '/usage');
}

/** POST /posts/validate — تحقق تجريبي بلا نشر. */
export async function validatePost(env: Env, body: ValidatePostRequest): Promise<ValidationResult> {
  const r = await json<Partial<ValidationResult>>(env, 'POST', '/posts/validate', body);
  return {
    valid: r.valid === true,
    errors: Array.isArray(r.errors) ? r.errors : [],
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
  };
}

const isPost = (d: unknown): d is Post =>
  !!d && typeof d === 'object' && typeof (d as Post).id === 'string' && typeof (d as Post).status === 'string';

/**
 * POST /posts — يعيد 201 (مقبول/مجدول/مسودة)، أو 207 (نجاح جزئي سريع)،
 * أو 422 مع كائن المنشور عند فشل كل الأهداف سريعاً (publishing.delivery.all_failed).
 */
export async function createPost(env: Env, body: CreatePostRequest): Promise<Post> {
  const r = await send(env, 'POST', '/posts', body, 25_000);
  if ((r.status === 201 || r.status === 207 || r.status === 422 || r.status === 200) && isPost(r.data)) {
    return r.data;
  }
  throw toError(r);
}

/** GET /posts/{pid} — الحالة النهائية تُعرف بالاستعلام (لا webhooks في الخطة المجانية). */
export async function getPost(env: Env, postId: string): Promise<Post> {
  const data = await json<unknown>(env, 'GET', `/posts/${encodeURIComponent(postId)}`);
  if (!isPost(data)) throw new SocialApiError(200, 'invalid_response', 'unexpected post shape');
  return data;
}

/**
 * PATCH /posts/{pid} — تغيير موعد منشور مجدول. يقبله SocialAPI للحالات draft وscheduled وfailed فقط،
 * ويرد 409 إن بدأ النشر، فلا يمكن أن يؤثر في منشور نُشر.
 */
export async function reschedulePost(env: Env, postId: string, scheduledAt: string): Promise<Post> {
  const data = await json<unknown>(env, 'PATCH', `/posts/${encodeURIComponent(postId)}`, { scheduled_at: scheduledAt });
  if (!isPost(data)) throw new SocialApiError(200, 'invalid_response', 'unexpected post shape');
  return data;
}

/**
 * DELETE /posts/{pid} — تحذير: يلغي المجدول، لكنه يحذف المنشور المنشور فعلاً من المنصات.
 * لا يُستدعى إلا من إلغاء الجدولة بعد التحقق من أن المنشور ما زال مجدولاً (managing.ts).
 */
export async function deletePost(env: Env, postId: string): Promise<void> {
  await json<unknown>(env, 'DELETE', `/posts/${encodeURIComponent(postId)}`);
}

/** POST /posts/{pid}/retry — يعيد محاولة التوصيلات الفاشلة لمنشور partial أو failed، ويستهلك رصيداً واحداً. */
export async function retryPost(env: Env, postId: string): Promise<void> {
  await json<unknown>(env, 'POST', `/posts/${encodeURIComponent(postId)}/retry`);
}

/**
 * GET /posts/{pid}/metrics — مقاييس التفاعل لكل منصة (SPEC §8 المقاييس).
 * يحدّث الأرقام من المنصات لحظة الطلب؛ على X (BYOK) قد تُحتسب القراءة ضمن استهلاك تطبيقك.
 */
export async function getPostMetrics(env: Env, postId: string): Promise<PostTarget[]> {
  const r = await json<{ data?: { targets?: PostTarget[] } } | null>(env, 'GET', `/posts/${encodeURIComponent(postId)}/metrics`);
  return Array.isArray(r?.data?.targets) ? r.data.targets : [];
}

export interface Engagement {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

const num = (...vals: unknown[]): number | null => {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};

/** يقرأ الأرقام بالتسميتين؛ الرقم الغائب يبقى null («غير متوفر») ولا يُعامل صفراً. */
export function readEngagement(m: TargetMetrics | undefined): Engagement {
  return {
    likes: num(m?.likes, m?.like_count),
    comments: num(m?.comments, m?.comments_count),
    shares: num(m?.shares, m?.shares_count),
    saves: num(m?.saves, m?.saves_count),
  };
}

/** POST /media/upload — رفع من الخادم (multipart، الحقل file، حتى 50MB) ويعيد media_id جاهزاً. */
export async function uploadMedia(env: Env, bytes: ArrayBuffer, filename: string, contentType: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([bytes], filename, { type: contentType }));
  const r = await send(env, 'POST', '/media/upload', form, 30_000);
  if (r.status < 200 || r.status >= 300) throw toError(r);
  const id = (r.data as { media_id?: unknown } | null)?.media_id;
  if (typeof id !== 'string' || !id) throw new SocialApiError(r.status, 'invalid_response', 'media_id missing');
  return id;
}

// ---------- بناء طلب المنشور ----------

export interface PublishableDraft {
  x_segments: string[];
  linkedin_text: string;
  media_id: string | null;
  platforms: Platform[];
}

export type PublishMode = { kind: 'draft' } | { kind: 'now' } | { kind: 'schedule'; at: string };

export class ConfigError extends Error {}

/**
 * منشور واحد لكل مسودة (SPEC §8 منطق النشر 2) بهدفين:
 * - X: النص = التغريدة الأولى، وبقية الثريد في platform_data.thread لهدف X وحده
 *   (موثّق في صفحة موصل X). هذا يُبقي الثريد خارج هدف لينكدن فلا يلزم منشور ثانٍ — انظر NOTES.md.
 * - LinkedIn: النص عبر تجاوز الهدف، والصورة (إن وجدت) على هدف لينكدن فقط لأن موصل X
 *   لا يدعم الوسائط حالياً ويتجاهلها — انظر NOTES.md.
 * بدون publish_now أو scheduled_at يُحفظ المنشور مسودة (لا تستهلك رصيداً)، وهذا وضع DRY_RUN.
 */
export function buildPostRequest(env: Env, draft: PublishableDraft, mode: PublishMode): CreatePostRequest {
  const targets: TargetRequest[] = [];
  for (const platform of draft.platforms) {
    const id = accountId(env, platform);
    if (!id) {
      throw new ConfigError(
        `معرّف حساب ${PLATFORM_LABEL[platform]} غير مضبوط (${platform === 'x' ? 'SOCIALAPI_X_ACCOUNT_ID' : 'SOCIALAPI_LINKEDIN_ACCOUNT_ID'}).`,
      );
    }
    if (platform === 'x') {
      const [first, ...rest] = draft.x_segments;
      targets.push({
        account_id: id,
        text: first ?? '',
        ...(rest.length ? { platform_data: { thread: rest } } : {}),
      });
    } else {
      targets.push({
        account_id: id,
        text: draft.linkedin_text,
        ...(draft.media_id ? { media: [{ source_type: 'media_id', source: draft.media_id }] } : {}),
      });
    }
  }
  if (targets.length === 0) throw new ConfigError('لم تُفعَّل أي منصة لهذه المسودة.');
  // نص المنشور العام: كل هدف يحمل نصه، لكن نضع نصاً قصيراً صالحاً لكل المنصات احتياطاً.
  const text = draft.platforms.includes('x') ? (draft.x_segments[0] ?? '') : draft.linkedin_text;
  return {
    text,
    targets,
    ...(mode.kind === 'now' ? { publish_now: true } : {}),
    ...(mode.kind === 'schedule' ? { scheduled_at: mode.at } : {}),
  };
}

export function buildValidateRequest(post: CreatePostRequest, scheduledAt?: string): ValidatePostRequest {
  return {
    ...(post.text ? { text: post.text } : {}),
    targets: post.targets,
    account_ids: post.targets.map((t) => t.account_id),
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
  };
}

// ---------- العرض للمستخدم ----------

export function platformName(p: string | undefined): string {
  if (p === 'twitter' || p === 'x') return 'X';
  if (p === 'linkedin' || p === 'linkedin_page') return 'لينكدن';
  return p ?? 'منصة';
}

export function describeIssue(i: ValidationIssue): string {
  const where = [
    i.platform ? platformName(i.platform) : null,
    i.segment_index !== undefined && i.segment_index !== null ? `تغريدة ${i.segment_index + 2}` : null,
    i.field ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${where ? `[${where}] ` : ''}${i.message ?? 'مشكلة غير محددة'}`;
}

/** SPEC §11 مع التمييز بين رموز 429 كما يوثقها دليل الأخطاء (انظر NOTES.md). */
export function socialApiErrorMessage(err: unknown): string {
  if (!(err instanceof SocialApiError)) return 'حدث خطأ غير متوقع أثناء التواصل مع SocialAPI.';
  const { status, code, meta } = err;
  const platformFromCode = /^platform\.([a-z_]+)\./.exec(code)?.[1];
  const platform = platformName(platformFromCode ?? (typeof meta.platform === 'string' ? meta.platform : undefined));

  if (status === 0) return 'تعذّر الاتصال بـ SocialAPI (مهلة أو انقطاع شبكة).';
  if (code === 'billing.post_limit') return 'بلغتَ حد منشورات الشهر في SocialAPI.';
  if (status === 429) {
    if (code === 'publishing.velocity_limit' || code === 'ratelimit.exceeded' || code.endsWith('.rate_limit')) {
      return 'SocialAPI أو المنصة تحدّ من سرعة الطلبات مؤقتاً. أعد المحاولة بعد قليل.';
    }
    return 'بلغتَ حد منشورات الشهر في SocialAPI.';
  }
  if (code === 'account.reconnection_required' || (code.startsWith('platform.') && (code.endsWith('.auth') || code.endsWith('.permission_denied')))) {
    return `يلزم إعادة ربط حساب ${platformFromCode ? platform : '(المنصة المعنية)'} من لوحة SocialAPI.`;
  }
  if (code.startsWith('byok.')) return 'إعدادات تطبيق X (BYOK) ناقصة أو غير صالحة في لوحة SocialAPI.';
  if (code === 'auth.insufficient_scope') {
    const scope = typeof meta.required_scope === 'string' ? ` (${meta.required_scope})` : '';
    return `مفتاح SocialAPI لا يملك الصلاحية المطلوبة${scope}.`;
  }
  if (status === 401 || code.startsWith('auth.')) return 'مفتاح SocialAPI غير صالح أو منتهٍ. حدّثه عبر wrangler secret put SOCIALAPI_KEY.';
  if (code === 'account.not_found') return 'معرّف الحساب غير موجود في SocialAPI. راجع SOCIALAPI_X_ACCOUNT_ID وSOCIALAPI_LINKEDIN_ACCOUNT_ID.';
  if (code === 'post.not_found') return 'المنشور غير موجود في SocialAPI (ربما حُذف من اللوحة).';
  if (code === 'post.state_invalid') return 'حالة المنشور في SocialAPI لا تسمح بهذا الإجراء الآن.';
  if (code === 'post.no_retryable_deliveries') return 'لا يوجد في المنشور جزء فاشل لإعادة محاولته.';
  if (code === 'billing.past_due') return 'حساب SocialAPI موقوف لتعثّر الدفع.';
  if (code === 'billing.storage_quota') return 'امتلأت مساحة الوسائط في SocialAPI.';
  if (code.startsWith('validation.') && err.apiMessage) return `رفضت SocialAPI الطلب: ${err.apiMessage}`;
  return `خطأ من SocialAPI (${code}).`;
}

/** رسالة خطأ هدف منشور (targets[].error) مع تلميح إعادة الربط عند أخطاء الصلاحيات. */
export function describeTargetError(t: PostTarget): string {
  const msg = t.error?.message || t.error?.code || 'فشل غير محدد';
  const reconnect = t.error?.category === 'auth' ? ' — يلزم إعادة ربط الحساب من لوحة SocialAPI' : '';
  return `${msg}${reconnect}`;
}
