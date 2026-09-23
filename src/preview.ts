// رسالة معاينة المسودة وأزرارها (SPEC §7).

import type { Draft, Idea } from './db.ts';
import {
  MAX_MESSAGE_LENGTH,
  button,
  EMPTY_KEYBOARD,
  type InlineButton,
  type InlineKeyboard,
  type MessageEntity,
} from './telegram.ts';
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
  retry: (kind: 'f' | 'g' | 'e' | 'p' | 's' | 'v', id: number) => `rt:${kind}:${id}`,
  // إدارة المنشور بعد إنشائه (managing.ts). pfp: بصمة الحالة والمنشور والموعد (postFingerprint)
  reschedule: (draftId: number) => `rsc:${draftId}`,
  rescheduleAt: (draftId: number, unix: number) => `rsa:${draftId}:${unix}`,
  confirmReschedule: (draftId: number, pfp: string, unix: number) => `rso:${draftId}:${pfp}:${unix}`,
  cancelSchedule: (draftId: number) => `csc:${draftId}`,
  confirmCancel: (draftId: number, pfp: string) => `cso:${draftId}:${pfp}`,
  retryPartial: (draftId: number) => `prt:${draftId}`,
  confirmRetry: (draftId: number, pfp: string) => `pro:${draftId}:${pfp}`,
  checkStatus: (draftId: number) => `chk:${draftId}`,
  snap: (draftId: number) => `snp:${draftId}`,
  archiveIdea: (ideaId: number) => `arc:${ideaId}`,
  unarchiveIdea: (ideaId: number) => `una:${ideaId}`,
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

const snapButtons = (d: Draft): InlineButton[] =>
  d.snap_script.length ? [button('📋 سكربت سناب', CB.snap(d.id))] : [];

export function draftKeyboard(d: Draft): InlineKeyboard {
  if (!isEditable(d)) return { inline_keyboard: [] };
  const on = (p: 'x' | 'linkedin') => d.platforms.includes(p);
  return {
    inline_keyboard: [
      [button('✅ انشر الآن', CB.publish(d.id)), button('🕒 جدول', CB.schedule(d.id))],
      [button('✏️ عدّل', CB.edit(d.id)), button('🔁 صياغة جديدة', CB.regenerate(d.id))],
      [button(d.media_id ? '🖼 استبدل الصورة' : '🖼 أرفق صورة', CB.image(d.id)), ...snapButtons(d)],
      [
        button(`X ${on('x') ? '✓' : '✗'}`, CB.toggle(d.id, 'x')),
        button(`LinkedIn ${on('linkedin') ? '✓' : '✗'}`, CB.toggle(d.id, 'li')),
      ],
      [button('🗑 تجاهل', CB.reject(d.id))],
    ],
  };
}

/**
 * أزرار المعاينة ورسائل النتائج حسب حالة المسودة:
 * المعلّقة أزرارها الكاملة، والمجدولة تغيير الموعد والإلغاء، والمنشورة جزئياً إعادة محاولة ما فشل،
 * وقيد النشر التحقق من الحالة. وسكربت سناب متاح في كل حالة عدا المتجاهلة.
 */
export function previewKeyboard(d: Draft): InlineKeyboard {
  if (isEditable(d)) return draftKeyboard(d);
  if (d.status === 'rejected') return EMPTY_KEYBOARD;
  const rows: InlineButton[][] = [];
  if (d.socialapi_post_id) {
    if (d.status === 'scheduled') {
      rows.push([button('🕒 غيّر الموعد', CB.reschedule(d.id)), button('🚫 ألغِ الجدولة', CB.cancelSchedule(d.id))]);
    } else if (d.status === 'partial') {
      rows.push([button('🔁 أعد محاولة ما فشل', CB.retryPartial(d.id))]);
    } else if (d.status === 'publishing') {
      rows.push([button('🔄 تحقق من الحالة', CB.checkStatus(d.id))]);
    }
  }
  const snap = snapButtons(d);
  if (snap.length) rows.push(snap);
  return { inline_keyboard: rows };
}

const unixOf = (o: ScheduleOption) => Math.floor(o.at.getTime() / 1000);

function optionRows(options: ScheduleOption[], data: (o: ScheduleOption) => string): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2).map((o) => button(o.label, data(o))));
  }
  return rows;
}

export function scheduleKeyboard(d: Draft, options: ScheduleOption[]): InlineKeyboard {
  const rows = optionRows(options, (o) => CB.scheduleAt(d.id, unixOf(o)));
  rows.push([button('↩️ رجوع', CB.back(d.id))]);
  return { inline_keyboard: rows };
}

/** خيارات الموعد الجديد لمنشور مجدول، دون موعده الحالي. */
export function rescheduleKeyboard(d: Draft, options: ScheduleOption[]): InlineKeyboard {
  const current = d.scheduled_at ? parseUtc(d.scheduled_at).getTime() : null;
  const rows = optionRows(
    options.filter((o) => o.at.getTime() !== current),
    (o) => CB.rescheduleAt(d.id, unixOf(o)),
  );
  rows.push([button('↩️ رجوع', CB.back(d.id))]);
  return { inline_keyboard: rows };
}

// ---------- أزرار /ideas ----------

export const ideaListRow = (id: number): InlineButton[] => [
  button(`صُغها #${id}`, CB.formulate(id)),
  button('🗄 أرشف', CB.archiveIdea(id)),
];

export const archivedIdeaRow = (id: number): InlineButton[] => [
  button(`↩️ تراجع عن أرشفة #${id}`, CB.unarchiveIdea(id)),
];

/** يستبدل صف الفكرة في أزرار رسالة /ideas كما وصلت مع الضغطة، أو null إن لم يوجد. */
export function replaceIdeaRow(kb: InlineKeyboard | undefined, ideaId: number, row: InlineButton[]): InlineKeyboard | null {
  if (!kb) return null;
  const mine = new Set([CB.formulate(ideaId), CB.archiveIdea(ideaId), CB.unarchiveIdea(ideaId)]);
  let found = false;
  const rows = kb.inline_keyboard.map((r) => {
    if (!r.some((b) => mine.has(b.callback_data))) return r;
    found = true;
    return row;
  });
  return found ? { inline_keyboard: rows } : null;
}

export function confirmKeyboard(confirmData: string, draftId: number): InlineKeyboard {
  return { inline_keyboard: [[button('تأكيد', confirmData), button('إلغاء', CB.cancelConfirm(draftId))]] };
}

export function retryKeyboard(data: string): InlineKeyboard {
  return { inline_keyboard: [[button('أعد المحاولة', data)]] };
}

// ---------- سكربت سناب للنسخ ----------

export interface FormattedText {
  text: string;
  entities: MessageEntity[];
}

const MAX_FRAME_CHARS = 3_000;

/** قص بوحدات UTF-16 دون شطر إيموجي (زوج بدائل) في منتصفه. */
function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/**
 * سكربت سناب في رسالة مستقلة، كل إطار منسّق كتلة نص (pre):
 * لمسة على الإطار تنسخه في تطبيقات تيليجرام. يُقسَّم على أكثر من رسالة عند تجاوز الحد.
 */
export function snapCopyMessages(d: Pick<Draft, 'id' | 'snap_script'>): FormattedText[] {
  const out: FormattedText[] = [];
  let current: FormattedText = { text: `📋 سكربت سناب — المسودة #${d.id}\nالمس أي إطار لنسخه:`, entities: [] };
  d.snap_script.forEach((raw, i) => {
    const frame = cutUtf16(raw, MAX_FRAME_CHARS);
    const label = `\n\n${i + 1})\n`;
    if (current.text.length + label.length + frame.length > MAX_MESSAGE_LENGTH) {
      out.push(current);
      current = { text: `📋 تابع سكربت سناب — المسودة #${d.id}`, entities: [] };
    }
    current.text += label;
    current.entities.push({ type: 'pre', offset: current.text.length, length: frame.length });
    current.text += frame;
  });
  out.push(current);
  return out;
}
