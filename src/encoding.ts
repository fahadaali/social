// ترميز base64 للبايتات (يلزم لإرسال الصوت إلى Whisper في Workers AI).

/** base64 أصلي في بيئة Workers (Uint8Array.prototype.toBase64)، مع بديل يدوي لغيرها. */
export function toBase64(buffer: ArrayBuffer, allowNative = true): string {
  const bytes = new Uint8Array(buffer) as Uint8Array & { toBase64?: () => string };
  if (allowNative && typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
