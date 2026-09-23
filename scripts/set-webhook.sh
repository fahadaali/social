#!/bin/sh
# ضبط webhook تيليجرام مع secret_token (SPEC §4.1 و§14.6). يُشغَّل مرة واحدة بعد أول نشر.
# الأسهل بلا طرفية: افتح /setup في رابط الـ Worker، فيربط تيليجرام بسر مشتق من التوكن (NOTES.md القسم 10).
# هذا السكربت لمن ضبط TELEGRAM_WEBHOOK_SECRET صراحةً فقط.
#
# الاستخدام:
#   TELEGRAM_BOT_TOKEN='...' TELEGRAM_WEBHOOK_SECRET='...' sh scripts/set-webhook.sh https://social.<حسابك>.workers.dev
#
# TELEGRAM_WEBHOOK_SECRET يجب أن يطابق السر المحفوظ بـ wrangler secret put، ويتكوّن من
# أحرف A-Z a-z 0-9 _ - فقط (مثلاً: openssl rand -hex 32).
set -eu

: "${TELEGRAM_BOT_TOKEN:?اضبط TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?اضبط TELEGRAM_WEBHOOK_SECRET}"
BASE="${1:?مرّر رابط الـ Worker، مثل https://social.example.workers.dev}"
BASE="${BASE%/}"

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"${BASE}/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"callback_query\"],\"drop_pending_updates\":true}"
echo
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo
