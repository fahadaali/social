# بوت النشر الذكي (Telegram → Claude → SocialAPI)

مساعد شخصي على تيليجرام يحفظ أفكارك، ويصوغها ثريداً لـ X ونصاً للينكدن وسكربتاً لسناب شات، ثم ينشرها أو يجدولها عبر SocialAPI **بعد تأكيدك فقط**.

- المواصفات الكاملة: [`SPEC.md`](SPEC.md)
- ملاحظات التنفيذ والانحرافات عن المواصفات: [`NOTES.md`](NOTES.md)

## حالة المشروع

| المرحلة | الحالة |
|---|---|
| 1. الأساس | منفّذة ومختبرة محلياً |
| 2. الانتظام | منفّذة ومختبرة محلياً: الخطة الأسبوعية، و`/plan` و`/queue` و`/usage` و`/pause` و`/resume`، والرسائل الصوتية عبر Whisper في Workers AI (التكلفة في `NOTES.md` القسم 6) |
| 3. التحليلات | منفّذة ومختبرة محلياً: `/stats`، وتقرير الخميس، واستخدام المقاييس في الخطة |

كل المراحل تنتظر النشر والتجربة على حساباتك الحقيقية (أسبوع `DRY_RUN`).

### الأوامر

| الأمر | الوظيفة |
|---|---|
| `/start` و`/help` | الترحيب والمساعدة وتحذيرات الإعداد |
| أي نص | فكرة جديدة تُحفظ ويُصنّف محورها، مع زر «صُغها الآن» |
| رسالة صوتية | تُفرَّغ بالعربية (حتى 5 دقائق)، ثم تُحفظ فكرةً ويظهر النص للتحقق منه |
| `/ideas` | آخر 10 أفكار جديدة، لكل فكرة زر «صُغها» |
| `/plan` | 3 موضوعات مقترحة (تستفيد من آخر مقاييس) |
| `/queue` | المسودات المعلّقة والمجدولة، مع زر «عرض» |
| `/stats` | تقرير الأداء الآن |
| `/usage` | رصيد منشورات SocialAPI المتبقي |
| `/pause` و`/resume` | إيقاف تذكير الانقطاع اليومي واستئنافه |

### المهام المجدولة (بتوقيت الرياض)
- يومياً 9:00 ص: متابعة المنشورات العالقة والمجدولة، وتذكير عند الانقطاع، وتنظيف السجلات.
- الأحد 8:00 ص: خطة الأسبوع.
- الخميس 5:00 م: تقرير الأداء.

## الإعداد (مرة واحدة)

المتطلبات: Node.js 22.18 أو أحدث (تحتاجه الاختبارات لتشغيل TypeScript مباشرة)، وحساب Cloudflare مجاني.

### 1. تيليجرام
1. أنشئ البوت من `@BotFather` واحفظ التوكن.
2. احصل على معرّفك الرقمي من `@userinfobot`.

### 2. SocialAPI.ai
1. أنشئ حساباً وعلامة (Brand) واحدة، واربط حساب لينكدن الشخصي.
2. أعدّ X عبر BYOK، واتبع [دليل SocialAPI](https://docs.social-api.ai/connectors/twitter-byok) حرفياً (صلاحيات Read and write، وOAuth 2.0، وعنوان الرجوع `https://api.social-api.ai/oauth/callback/twitter`).
3. أنشئ مفتاح API **محدود الصلاحيات** من Settings → API Keys بالصلاحيات: `posts:read`، `posts:write`، `media:write`، و`accounts:read` (لقراءة معرّفات الحسابات فقط). مسار `/v1/usage` متاح لأي مفتاح.
4. اعرض معرّفات الحسابات:
   ```sh
   SOCIALAPI_KEY='sapi_key_...' node scripts/socialapi-check.mjs accounts
   ```

### 3. Anthropic
أنشئ مفتاح API من Console، وضع حداً شهرياً للإنفاق.

### 4. ملفاتك
عبّئ `config/voice.md` بدليل أسلوبك و5 إلى 10 نماذج من كتاباتك، و`config/pillars.md` بمحاورك. اكتب كل محور عنواناً يبدأ بـ `##`.

### 5. Cloudflare
```sh
npm install
npx wrangler login
npx wrangler d1 create social          # انسخ database_id الناتج إلى wrangler.toml
```
في `wrangler.toml` عبّئ:
- `database_id`
- `ALLOWED_TELEGRAM_USER_ID`
- `SOCIALAPI_X_ACCOUNT_ID`
- `SOCIALAPI_LINKEDIN_ACCOUNT_ID`

ثم:
```sh
npm run deploy                          # يطبّق ترحيلات D1 ثم ينشر الـ Worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # مثلاً ناتج: openssl rand -hex 32
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SOCIALAPI_KEY
```

ربط Workers AI (`[ai]` في `wrangler.toml`) لتفريغ الرسائل الصوتية لا يحتاج أي مفتاح أو إعداد إضافي.

**النشر التلقائي من GitHub (Workers Builds):** من لوحة Cloudflare: Workers & Pages ← Create ← Import a repository، واختر هذا المستودع، وسمِّ الـ Worker باسم `social` (يطابق `name` في `wrangler.toml`). اضبط أمر النشر (Deploy command) على `npm run deploy` حتى تُطبَّق الترحيلات الجديدة تلقائياً. بعدها يُنشر كل دفع (push) إلى الفرع الرئيسي.

### 6. تفعيل الـ webhook
```sh
TELEGRAM_BOT_TOKEN='...' TELEGRAM_WEBHOOK_SECRET='...' sh scripts/set-webhook.sh https://social.<حسابك>.workers.dev
```
أرسل `/start` للبوت. إن ظهرت تحذيرات عن الإعداد فستجدها في رسالة الترحيب.

### 7. التجربة
- اختبار الثريد مع لينكدن (معيار القبول 4) مجاناً:
  ```sh
  SOCIALAPI_KEY='...' node scripts/socialapi-check.mjs thread-test <X_ACCOUNT_ID> <LINKEDIN_ACCOUNT_ID> --draft
  ```
  وسجّل النتيجة في `NOTES.md`.
- جرّب أسبوعاً على `DRY_RUN = "true"`. في هذا الوضع يُحفظ كل «نشر» مسودةً في SocialAPI، ولا يُنشر ولا يُستهلك رصيد.
- بعدها غيّر القيمة إلى `"false"` في `wrangler.toml` وادفع التغيير.

## التطوير

```sh
npm run typecheck   # TypeScript
npm test            # اختبارات الوحدات (Node test runner)
npm run test:e2e    # اختبارات طرفية: الـ Worker المجمّع داخل workerd مع D1 محلية وخوادم وهمية
npm run check       # الكل
```
لا تصل الاختبارات إلى أي خدمة خارجية. للتشغيل المحلي بـ `npm run dev` ضع الأسرار في ملف `.dev.vars`، وهو مستثنى من git. ربط Workers AI يعمل عن بُعد دائماً، فيحتاج `npx wrangler login`.

## البنية

```
src/index.ts            fetch() للـ webhook + scheduled() للـ Cron
src/auth.ts             التحقق من السر والمالك
src/telegram.ts         Bot API (إرسال، تعديل، أزرار، تنزيل ملفات)
src/claude.ts           Messages API بمخرجات JSON مقيّدة بمخطط
src/socialapi.ts        المنشورات، التحقق، الوسائط، الاستهلاك
src/db.ts               D1
src/time.ts             توقيت الرياض ↔ UTC
src/text.ts             قيود الطول (عدّ أحرف X الموزون، كلمات لينكدن، إطارات سناب)
src/preview.ts          رسالة المعاينة والأزرار
src/ideas.ts · drafting.ts · publishing.ts · images.ts · planning.ts
src/status.ts           /queue · /usage · /pause · /resume
src/analytics.ts        جمع المقاييس، أداء المحاور، لقطة المقاييس للخطة
src/reporting.ts        /stats والتقرير الأسبوعي
src/voice.ts            تفريغ الرسائل الصوتية (Whisper في Workers AI)
src/handlers/           messages · callbacks · cron
src/prompts/            classify · draft · revise · plan · report · shared
migrations/             0001_init.sql (من SPEC حرفياً) + 0002_draft_notes.sql
config/                 voice.md · pillars.md (يعبّئهما المالك)
scripts/                set-webhook.sh · socialapi-check.mjs
test/                   unit/ · e2e/
```
