// نص خطأ سحب لينكدن للمالك: رسالة SocialAPI المعتادة، مع تلميح الصلاحية عند رفض القراءة.

import { SocialApiError, socialApiErrorMessage } from './socialapi.ts';

export function errorText(err: unknown): string {
  if (err instanceof SocialApiError) {
    if (err.status === 403 || err.code === 'account.permission_missing') {
      return 'حساب لينكدن لا يملك صلاحية التحليلات (analytics.read) في SocialAPI. أعد ربطه من لوحة SocialAPI واختر Analytics.';
    }
    return socialApiErrorMessage(err);
  }
  return err instanceof Error ? err.message.slice(0, 400) : 'خطأ غير معروف';
}
