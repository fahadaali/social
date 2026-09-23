// أدوات فحص SocialAPI قبل التشغيل — لا تنشر شيئاً ولا تحذف شيئاً.
//
//   SOCIALAPI_KEY='sapi_key_...' node scripts/socialapi-check.mjs accounts
//     يعرض الحسابات المربوطة ومعرّفاتها (acc_...) لنسخها إلى متغيرات Cloudflare (أو أرسل /start للبوت).
//
//   SOCIALAPI_KEY='...' node scripts/socialapi-check.mjs thread-test <X_ACCOUNT_ID> <LINKEDIN_ACCOUNT_ID> [--draft]
//     اختبار معيار القبول 4 (SPEC §8.3) عبر مسار التحقق المجاني POST /v1/posts/validate:
//       (أ) الطريقة المعتمدة في الكود: الثريد في platform_data.thread لهدف X وحده.
//       (ب) الطريقة المذكورة في SPEC: segments على مستوى المنشور مع هدف لينكدن.
//     مع --draft يُنشئ أيضاً مسودة واحدة (مجانية، لا تُنشر) بالطريقة (أ) ويعرضها كما خزّنتها SocialAPI.
//     المسودة تبقى في لوحة SocialAPI ويمكنك حذفها يدوياً.

const BASE = 'https://api.social-api.ai/v1';
const key = process.env.SOCIALAPI_KEY;
if (!key) {
  console.error('اضبط SOCIALAPI_KEY أولاً.');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const show = (title, r) => console.log(`\n=== ${title} → HTTP ${r.status}\n${JSON.stringify(r.data, null, 2)}`);

const [cmd, xId, liId, flag] = process.argv.slice(2);

if (cmd === 'accounts') {
  const r = await call('GET', '/accounts');
  if (r.status !== 200) show('GET /accounts', r);
  else for (const a of r.data.data ?? []) console.log(`${a.platform.padEnd(10)} ${a.id}  ${a.username ?? ''}  (${a.status})`);
} else if (cmd === 'thread-test' && xId && liId) {
  const thread = ['تغريدة اختبار ثانية', 'تغريدة اختبار ثالثة'];
  const viaPlatformData = {
    text: 'تغريدة اختبار أولى',
    targets: [
      { account_id: xId, text: 'تغريدة اختبار أولى', platform_data: { thread: thread.map((text) => ({ text, media_ids: [] })) } },
      { account_id: liId, text: 'نص اختبار للينكدن' },
    ],
    account_ids: [xId, liId],
  };
  const viaSegments = {
    text: 'تغريدة اختبار أولى',
    segments: thread.map((text) => ({ text })),
    targets: [
      { account_id: xId, text: 'تغريدة اختبار أولى' },
      { account_id: liId, text: 'نص اختبار للينكدن' },
    ],
    account_ids: [xId, liId],
  };
  show('(أ) validate: platform_data.thread على هدف X', await call('POST', '/posts/validate', viaPlatformData));
  show('(ب) validate: segments على مستوى المنشور + لينكدن', await call('POST', '/posts/validate', viaSegments));
  if (flag === '--draft') {
    const { account_ids, ...draftBody } = viaPlatformData; // بلا publish_now ولا scheduled_at = مسودة مجانية
    const created = await call('POST', '/posts', draftBody);
    show('مسودة (أ) — POST /posts بلا publish_now', created);
    if (created.data?.id) show('المسودة كما خزّنتها SocialAPI', await call('GET', `/posts/${created.data.id}`));
  }
} else {
  console.log('الأوامر: accounts | thread-test <X_ACCOUNT_ID> <LINKEDIN_ACCOUNT_ID> [--draft]');
}
