// رفع الصور إلى X مباشرة (X API v2: POST /2/media/upload، الرفع البسيط للصور) بتوقيع OAuth 1.0a
// بمفاتيح تطبيق X نفسه الذي رُبط به حساب X في SocialAPI (BYOK). يُمرَّر المعرّف الناتج إلى SocialAPI
// بصيغة platform_attachment_id على التغريدة الأولى، لأن موصل X في SocialAPI لا يرفع الوسائط بنفسه بعد.
// انظر NOTES.md القسم 2.2.

import type { Env } from './env.ts';

const UPLOAD_URL = 'https://api.x.com/2/media/upload';

/** حد الصور في رفع X عبر الـ API. */
export const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** صلاحية معرّف الوسائط عند X (expires_after_secs = 24 ساعة) ناقص هامش: بعدها لا نعتمد على المعرّف. */
export const X_MEDIA_TTL_MS = 23 * 60 * 60 * 1000;

export class XApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`x ${status} ${detail}`);
    this.name = 'XApiError';
    this.status = status;
    this.detail = detail;
  }
}

interface XKeys {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

function keys(env: Env): XKeys | null {
  const k = {
    consumerKey: str(env.X_API_KEY),
    consumerSecret: str(env.X_API_SECRET),
    token: str(env.X_ACCESS_TOKEN),
    tokenSecret: str(env.X_ACCESS_TOKEN_SECRET),
  };
  return k.consumerKey && k.consumerSecret && k.token && k.tokenSecret ? k : null;
}

/** المفاتيح الأربعة مضبوطة كلها؛ بدونها تُرسل الصورة لـ X عبر SocialAPI (تتجاهلها حالياً). */
export function xUploadConfigured(env: Env): boolean {
  return keys(env) !== null;
}

/** ترميز RFC 3986 كما يشترطه OAuth 1.0a (encodeURIComponent يترك !*'() بلا ترميز). */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * ترويسة Authorization بتوقيع HMAC-SHA1. حقول جسم multipart لا تدخل في التوقيع (المواصفة تُدخل
 * فقط جسم application/x-www-form-urlencoded)، وطلبنا بلا معاملات استعلام.
 */
export async function oauthHeader(
  method: string,
  url: string,
  k: XKeys,
  nonce: string = crypto.randomUUID().replace(/-/g, ''),
  timestamp: string = String(Math.floor(Date.now() / 1000)),
): Promise<string> {
  const params: Record<string, string> = {
    oauth_consumer_key: k.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: k.token,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const signature = await hmacSha1Base64(`${percentEncode(k.consumerSecret)}&${percentEncode(k.tokenSecret)}`, base);
  const all = { ...params, oauth_signature: signature };
  return `OAuth ${Object.keys(all)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(all[key as keyof typeof all])}"`)
    .join(', ')}`;
}

/** يرفع صورة إلى X ويعيد معرّف الوسائط (رقم نصي) لاستخدامه في تغريدة خلال 24 ساعة. */
export async function uploadXImage(env: Env, bytes: ArrayBuffer, filename: string, contentType: string): Promise<string> {
  const k = keys(env);
  if (!k) throw new XApiError(0, 'not_configured');
  if (bytes.byteLength > X_MAX_IMAGE_BYTES) throw new XApiError(413, 'too_large');
  const form = new FormData();
  form.append('media', new File([bytes], filename, { type: contentType }));
  form.append('media_category', 'tweet_image');
  form.append('media_type', contentType);
  let res: Response;
  try {
    res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { authorization: await oauthHeader('POST', UPLOAD_URL, k) },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new XApiError(0, err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new XApiError(res.status, describeXError(data));
  // v2 يعيد {data: {id, media_key, expires_after_secs}}؛ ونقبل صيغة v1.1 (media_id_string) احتياطاً
  const d = data as { data?: { id?: unknown }; media_id_string?: unknown } | null;
  const id = d?.data?.id ?? d?.media_id_string;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new XApiError(res.status, 'media id missing');
  return id;
}

function describeXError(data: unknown): string {
  const d = data as { title?: unknown; detail?: unknown; errors?: Array<{ message?: unknown }> } | null;
  const parts = [d?.title, d?.detail, d?.errors?.[0]?.message].filter((p): p is string => typeof p === 'string' && !!p);
  return parts.join(' — ').slice(0, 200);
}

/** رسالة عربية لخطأ رفع X. */
export function xErrorMessage(err: unknown): string {
  if (!(err instanceof XApiError)) return 'خطأ غير متوقع أثناء رفع الصورة إلى X.';
  if (err.detail === 'not_configured') return 'مفاتيح X غير مضبوطة.';
  if (err.detail === 'too_large') return 'الصورة أكبر من 5MB، وهو حد X للصور.';
  if (err.status === 0) return 'تعذّر الاتصال بـ X (مهلة أو انقطاع شبكة).';
  if (err.status === 401) return 'رفض X مفاتيح الرفع. راجع X_API_KEY وX_API_SECRET وX_ACCESS_TOKEN وX_ACCESS_TOKEN_SECRET.';
  if (err.status === 403) {
    return `رفض X الرفع (403)؛ تأكد أن صلاحية التطبيق «Read and write» وأعد توليد Access Token بعدها${err.detail ? `: ${err.detail}` : '.'}`;
  }
  if (err.status === 429) return 'بلغت حد طلبات X مؤقتاً. أعد المحاولة بعد قليل.';
  return `خطأ من X (http.${err.status})${err.detail ? `: ${err.detail}` : ''}.`;
}
