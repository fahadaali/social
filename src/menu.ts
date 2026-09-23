// الوصول السريع للأوامر (طلب المالك): لوحة أزرار ثابتة أسفل المحادثة، وقائمة الأوامر في زر «القائمة».
// ضغطة زر في اللوحة تصل رسالةً نصها نص الزر، فتُعامل أمراً ولا تُحفظ فكرةً.

import type { BotCommand, ReplyKeyboard } from './telegram.ts';

export const MENU_LABELS = {
  ideas: '💡 أفكاري',
  queue: '📋 قائمة الانتظار',
  plan: '🗓 اقترح موضوعات',
  stats: '📊 تقرير الأداء',
  usage: '💳 الرصيد',
  export: '💾 نسخة احتياطية',
  pause: '⏸ أوقف التذكير',
  resume: '▶️ استأنف التذكير',
  help: '❓ مساعدة',
} as const;

type MenuCommand = keyof typeof MENU_LABELS;

/** بلا محدِّد شكل الإيموجي (U+FE0F) والمسافات الطرفية، تحسباً لاختلاف تطبيقات تيليجرام في إرساله. */
const normalize = (text: string) => text.replace(/\uFE0F/gu, '').trim();

const COMMAND_BY_LABEL = new Map<string, string>(
  (Object.entries(MENU_LABELS) as [MenuCommand, string][]).map(([command, label]) => [normalize(label), `/${command}`]),
);

/** الأمر المقابل لنص زر في اللوحة (مثل «/queue»)، أو null إن لم يكن النص زراً. */
export function menuCommand(text: string): string | null {
  return COMMAND_BY_LABEL.get(normalize(text)) ?? null;
}

/** اللوحة الثابتة؛ زر التذكير يتبدّل بين «أوقف» و«استأنف» بحسب حالته. */
export function menuKeyboard(remindersPaused: boolean): ReplyKeyboard {
  const L = MENU_LABELS;
  return {
    keyboard: [
      [{ text: L.ideas }, { text: L.queue }],
      [{ text: L.plan }, { text: L.stats }],
      [{ text: L.usage }, { text: L.export }],
      [{ text: remindersPaused ? L.resume : L.pause }, { text: L.help }],
    ],
    is_persistent: true,
    resize_keyboard: true,
    input_field_placeholder: 'اكتب فكرتك أو أرسل رسالة صوتية',
  };
}

/** قائمة زر «القائمة» (setMyCommands)، تُضبط لمحادثة المالك وحده عند /start. */
export const BOT_COMMANDS: BotCommand[] = [
  { command: 'ideas', description: 'أحدث الأفكار في البنك' },
  { command: 'queue', description: 'المسودات المجدولة والمعلّقة' },
  { command: 'plan', description: 'اقترح 3 موضوعات للنشر' },
  { command: 'stats', description: 'تقرير الأداء الآن' },
  { command: 'usage', description: 'رصيد المنشورات المتبقي' },
  { command: 'export', description: 'نسخة احتياطية (ملف JSON)' },
  { command: 'pause', description: 'أوقف تذكيرات الانقطاع' },
  { command: 'resume', description: 'استأنف تذكيرات الانقطاع' },
  { command: 'help', description: 'طريقة العمل والأوامر' },
];
