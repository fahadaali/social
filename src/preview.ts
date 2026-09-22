// رسالة معاينة المسودة وأزرارها (SPEC §7).

import type { Draft, Idea } from './db.ts';
import { MAX_MESSAGE_LENGTH, button, type InlineKeyboard } from './telegram.ts';
import { X_MAX_WEIGHTED, checkDraftLimits, xWeightedLength } from './text.ts';
import { formatRiyadh, parseUtc, type ScheduleOption } from './time.ts';

// بيانات الأزرار (callback_data ≤ 64 بايت). الصيغة: فعل:معامل:معامل
export const CB = {
  formulate: (ideaId: number) => `fmt:${ideaId}`,
  reclassify: (ideaId: number) => `cls:${ideaId}`,
  publish: (draftId: number) => `pub:${draftId}`,
  schedule: (draftId: number) => `sch:${draftId}`,
  scheduleAt: (draftId: number, unix: number) => `sat:${draftId}:${unix}`,
  // fp: بصمة النسخة والمنصات والصورة (publishing.ts) حتى لا يُنشر محتوى تغيّر بعد عرض التأكيد
  confirmNow: (draftId: number, fp: string) => `okn:${draftId}:${fp}`,
  confirmSchedule: (draftId: number, fp: string, unix: number) => `oks:${draftId}:${fp}:${unix}`,
  cancelConfirm: (draftId: number) => `no:${draftId}`,
  back: (draftId: number) => `bk:${draftId}`,
  edit: (draftId: number) => `edt:${draftId}`,
  regenerate: (draftId: number) => `rgn:${draftId}`,
  image: (draftId: number) => `img:${draftId}`,
  toggle: (draftId: number, p: 'x' | 'li') => `tgl:${draftId}:${p}`,
  reject: (draftId: number) => `rej:${draftId}`,
  cancelAwaiting: () => 'cxl',
  plan: () => 'plan',
  ideas: () => 'ideas',
  planPick: (nonce: string, index: number) => `ps:${nonce}:${index}`,
  show: (draftId: number) => `shw:${draftId}`,
  retry: (kind: 'f' | 'g' | 'e' | 'p' | 's', id: number) => `rt:${kind}:${id}`,
} as const;

export const EDITABLE_STATUSES = ['pending', 'failed'] as const;

export function isEditable(d: Draft): boolean {
  return (EDITABLE_STATUSES as readonly string[]).includes(d.status);
}

export function versionLabel(d: Draft): string {
  return `نسخة ${d.revision + 1}`;
}

export function header(d: Draft, idea: Idea | null): string {
  return `📝 مسودة #${d.id} — المحور: ${idea?.pillar ?? '—'} (${versionLabel(d)})`;
}

function xSection(d: Draft): string {
  const n = d.x_segments.length;
  const title = n === 1 ? '【X — تغريدة واحدة】' : `【X — ثريد من ${n} تغريدات】`;
  const tweets = d.x_segments.map((t, i) => {
    const len = xWeightedLength(t);
    const warn = len > X_MAX_WEIGHTED ? ` ⚠️ (${len}/${X_MAX_WEIGHTED})` : '';
    return `${i + 1}/ ${t}${warn}`;
  });
  return `${title}\n${tweets.join('\n\n')}`;
}

function snapSection(d: Draft): string | null {
  if (d.snap_script.length === 0) return null;
  const frames = d.snap_script.map((f, i) => `${i + 1}) ${f}`);
  return `【سناب — للنشر اليدوي】\n${frames.join('\n\n')}`;
}

export function statusLine(d: Draft): string | null {
  switch (d.status) {
    case 'scheduled':
      return d.scheduled_at ? `🕒 مجدولة: ${formatRiyadh(parseUtc(d.scheduled_at))} (بتوقيت الرياض)` : '🕒 مجدولة';
    case 'publishing':
      return '⏳ جارٍ النشر…';
    case 'published':
      return '✅ نُشرت';
    case 'partial':
      return '⚠️ نُشرت جزئياً';
    case 'failed':
      return '❌ فشل النشر — يمكنك المحاولة مجدداً بعد مراجعة لوحة SocialAPI';
    case 'rejected':
      return '🗑 تم التجاهل';
    default:
      return null;
  }
}

function footerSection(d: Draft): string | null {
  const lines: string[] = [];
  if (d.media_id) {
    lines.push('📎 صورة مرفقة — تُنشر مع لينكدن فقط (X لا يدعم الصور عبر SocialAPI حالياً)');
  } else if (d.needs_visual) {
    const brief = d.visual_brief ? `: ${d.visual_brief}` : '';
    lines.push(`🖼 يُقترح تصميم${brief} (صمّمه في Claude Design وأرسله هنا)`);
  }
  if (d.notes) lines.push(`🔎 للتحقق: ${d.notes}`);
  for (const v of checkDraftLimits(d)) lines.push(`⚠️ ${v.message}`);
  const status = statusLine(d);
  if (status) lines.push(status);
  return lines.length ? lines.join('\n') : null;
}

/**
 * نص المعاينة مقسّماً على رسائل لا تتجاوز حد تيليجرام (4096)؛ الأزرار تُلحق بالأخيرة.
 * في الغالب رسالة واحدة، وعند الطول: رسالة X ثم رسالة لينكدن (وما بعدها).
 */
export function renderPreview(d: Draft, idea: Idea | null): string[] {
  const sections = [
    `${header(d, idea)}\n\n${xSection(d)}`,
    `【LinkedIn】\n${d.linkedin_text}`,
    snapSection(d),
    footerSection(d),
  ].filter((s): s is string => !!s);

  const chunks: string[] = [];
  let current = '';
  for (const s of sections) {
    const candidate = current ? `${current}\n\n${s}` : s;
    if (candidate.length <= MAX_MESSAGE_LENGTH) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = s.length <= MAX_MESSAGE_LENGTH ? s : s.slice(0, MAX_MESSAGE_LENGTH - 1) + '…';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function draftKeyboard(d: Draft): InlineKeyboard {
  if (!isEditable(d)) return { inline_keyboard: [] };
  const on = (p: 'x' | 'linkedin') => d.platforms.includes(p);
  return {
    inline_keyboard: [
      [button('✅ انشر الآن', CB.publish(d.id)), button('🕒 جدول', CB.schedule(d.id))],
      [button('✏️ عدّل', CB.edit(d.id)), button('🔁 صياغة جديدة', CB.regenerate(d.id))],
      [button(d.media_id ? '🖼 استبدل الصورة' : '🖼 أرفق صورة', CB.image(d.id))],
      [
        button(`X ${on('x') ? '✓' : '✗'}`, CB.toggle(d.id, 'x')),
        button(`LinkedIn ${on('linkedin') ? '✓' : '✗'}`, CB.toggle(d.id, 'li')),
      ],
      [button('🗑 تجاهل', CB.reject(d.id))],
    ],
  };
}

export function scheduleKeyboard(d: Draft, options: ScheduleOption[]): InlineKeyboard {
  const unix = (o: ScheduleOption) => Math.floor(o.at.getTime() / 1000);
  const rows: InlineKeyboard['inline_keyboard'] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2).map((o) => button(o.label, CB.scheduleAt(d.id, unix(o)))));
  }
  rows.push([button('↩️ رجوع', CB.back(d.id))]);
  return { inline_keyboard: rows };
}

export function confirmKeyboard(confirmData: string, draftId: number): InlineKeyboard {
  return { inline_keyboard: [[button('تأكيد', confirmData), button('إلغاء', CB.cancelConfirm(draftId))]] };
}

export function retryKeyboard(data: string): InlineKeyboard {
  return { inline_keyboard: [[button('أعد المحاولة', data)]] };
}
