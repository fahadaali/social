// ملفات المالك مضمّنة كنصوص عند البناء (SPEC §6) — لا تُقرأ من الشبكة.

import voiceMd from '../config/voice.md';
import pillarsMd from '../config/pillars.md';
import { isEffectivelyEmpty, parsePillars } from './prompts/shared.ts';

export const VOICE_MD: string = voiceMd;
export const PILLARS_MD: string = pillarsMd;
export const PILLARS: string[] = parsePillars(pillarsMd);
export const VOICE_FILLED: boolean = !isEffectivelyEmpty(voiceMd);
