// صفحة /setup: فحص الإعداد وربط تيليجرام من المتصفح، بلا طرفية ولا رابط فيه التوكن (NOTES.md القسم 10).
// لا تقبل أي مدخلات ولا تعرض أي قيمة: أسماء الإعدادات الناقصة فقط، ونتيجة الربط. تكرار فتحها لا يضر.

import { webhookSecret } from './auth.ts';
import { isDryRun, ownerId, type Env } from './env.ts';
import { ensureSchema } from './migrations.ts';
import { setWebhook, TelegramError } from './telegram.ts';

const SETTINGS: ReadonlyArray<readonly [keyof Env, 'Secret' | 'Text']> = [
  ['TELEGRAM_BOT_TOKEN', 'Secret'],
  ['ANTHROPIC_API_KEY', 'Secret'],
  ['SOCIALAPI_KEY', 'Secret'],
  ['ALLOWED_TELEGRAM_USER_ID', 'Text'],
  ['SOCIALAPI_X_ACCOUNT_ID', 'Text'],
  ['SOCIALAPI_LINKEDIN_ACCOUNT_ID', 'Text'],
];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const code = (s: string) => `<code>${escapeHtml(s)}</code>`;

function telegramReason(err: unknown): string {
  if (!(err instanceof TelegramError)) return 'خطأ غير معروف';
  // تيليجرام يرد بـ 401 أو 404 حين يكون التوكن خاطئاً أو ناقصاً
  if (err.code === 401 || err.code === 404) return 'تيليجرام لم يقبل التوكن؛ راجع قيمة TELEGRAM_BOT_TOKEN';
  return err.description || `رمز ${err.code}`;
}

export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const items: string[] = [];
  let missing = 0;
  const mark = (ok: boolean, html: string) => {
    if (!ok) missing++;
    items.push(`<li>${ok ? '✅' : '❌'} ${html}</li>`);
  };

  if (!env.DB) {
    mark(false, `قاعدة البيانات غير مربوطة: أضف من إعدادات الـ Worker ربط D1 باسم ${code('DB')}`);
  } else {
    try {
      await ensureSchema(env.DB);
      mark(true, 'قاعدة البيانات وجداولها جاهزة');
    } catch (err) {
      console.error(JSON.stringify({ evt: 'setup_schema_failed', err: err instanceof Error ? err.message : 'unknown' }));
      mark(false, 'تعذّر تجهيز قاعدة البيانات (التفاصيل في سجلات الـ Worker)');
    }
  }

  for (const [name, kind] of SETTINGS) {
    // معرّفا الحسابين يعرضهما البوت للنسخ عند /start (accounts.ts)
    const where = name.endsWith('_ACCOUNT_ID') ? '، وتجد قيمته بإرسال /start للبوت' : '';
    if (String(env[name] ?? '').trim() === '') mark(false, `${code(name)} غير مضبوط: أضفه بنوع ${kind}${where}`);
    else if (name === 'ALLOWED_TELEGRAM_USER_ID' && !ownerId(env)) mark(false, `${code(name)} يجب أن يكون أرقاماً فقط`);
    else mark(true, code(name));
  }

  const secret = await webhookSecret(env);
  if (!secret) {
    mark(false, `لم يُربط تيليجرام بعد: يلزم ${code('TELEGRAM_BOT_TOKEN')}`);
  } else {
    const hook = `${new URL(request.url).origin}/webhook`;
    try {
      await setWebhook(env, hook, secret);
      mark(true, `تيليجرام مربوط بالعنوان ${code(hook)}`);
    } catch (err) {
      mark(false, `تعذّر ربط تيليجرام: ${escapeHtml(telegramReason(err))}`);
    }
  }

  items.push(
    isDryRun(env)
      ? `<li>🧪 وضع التجربة مفعّل: لا نشر فعلي حتى تضيف ${code('DRY_RUN')} بقيمة ${code('false')}</li>`
      : `<li>🚀 النشر الفعلي مفعّل (${code('DRY_RUN = false')})</li>`,
  );
  const next = missing
    ? 'أكمل ما عليه ❌ من لوحة Cloudflare، ثم افتح هذه الصفحة من جديد.'
    : 'كل شيء جاهز. التالي: أرسل /start للبوت في تيليجرام.';

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>إعداد بوت النشر</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.9; }
ul { padding: 0; }
li { list-style: none; margin: 0.4rem 0; }
code { direction: ltr; unicode-bidi: isolate; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>إعداد بوت النشر</h1>
<ul>
${items.join('\n')}
</ul>
<p>${next}</p>
</body>
</html>
`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
