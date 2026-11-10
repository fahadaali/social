// قياس الأسلوب على مجموعة ثابتة من الأفكار (eval/ideas.md)، لمعرفة أثر أي تعديل في التعليمات أو دليل الأسلوب بالأرقام.
// يمرّ كل فكرة على مسار البوت نفسه: صياغة ← فحص آلي (الأطوال والعبارات الممنوعة) وتصحيحه ← مدقّق الأسلوب ← إعادة الكتابة بالبنود الساقطة ← مراجعة ثانية.
// يسجّل درجة المسودة الأولى (جودة تعليمات الصياغة) والنهائية (بعد التدقيق)، ويقارن بآخر تشغيل محفوظ.
//
//   ANTHROPIC_API_KEY='sk-ant-...' node scripts/style-eval.ts
//   ANTHROPIC_API_KEY='...' node scripts/style-eval.ts --only 1,4 --model claude-sonnet-5 --label "بعد تعديل الدليل"
//
// التكلفة: من 2 إلى 5 طلبات لكل فكرة (قرابة 20 إلى 50 طلباً للمجموعة كاملة). لا ينشر شيئاً ولا يلمس قاعدة البوت.
// النتائج في eval/results/<الوقت>.json.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { claudeJson, type ClaudeMessage } from '../src/claude.ts';
import type { Env } from '../src/env.ts';
import { DRAFT_MAX_TOKENS, DRAFT_SCHEMA, draftUser, fixViolationsTurn } from '../src/prompts/draft.ts';
import {
  parseReview,
  REVIEW_CRITERIA,
  REVIEW_MAX_TOKENS,
  REVIEW_SCHEMA,
  reviewFixTurn,
  reviewSystemPrompt,
  reviewUser,
  type StyleReview,
} from '../src/prompts/review.ts';
import { stripComments, writerSystemPrompt } from '../src/prompts/shared.ts';
import { checkStyle } from '../src/style.ts';
import { checkDraftLimits, parseDraftContent, type DraftContent } from '../src/text.ts';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

// ---------- الإعداد ----------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const defaultModel = read('wrangler.toml').match(/^CLAUDE_MODEL\s*=\s*"([^"]+)"/m)?.[1] ?? 'claude-sonnet-5';
const model = flag('model') ?? defaultModel;
const only = flag('only')?.split(',').map((s) => s.trim());
const label = flag('label') ?? '';
const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' } as Env;
const CALL_BUDGET_MS = 5 * 60_000;
const CONCURRENCY = 3;

interface EvalIdea {
  id: string;
  pillar: string | null;
  text: string;
}

/** الأفكار من eval/ideas.md: كل فكرة تحت «## …»، وسطر «المحور: …» اختياري. */
export function parseIdeas(md: string): EvalIdea[] {
  return stripComments(md)
    .split(/^##\s+/m)
    .slice(1)
    .map((block) => {
      const [head = '', ...rest] = block.split('\n');
      const pillarLine = rest.find((l) => /^المحور\s*[:：]/.test(l.trim()));
      const text = rest.filter((l) => l !== pillarLine).join('\n').trim();
      return { id: head.trim(), pillar: pillarLine ? pillarLine.replace(/^\s*المحور\s*[:：]\s*/, '').trim() : null, text };
    })
    .filter((i) => i.text);
}

// ---------- الاستدعاءات (كما في src/drafting.ts) ----------

const voiceMd = read('config/voice.md');
const writerSystem = writerSystemPrompt(voiceMd, read('config/pillars.md'));
const reviewerSystem = reviewSystemPrompt(voiceMd);

let calls = 0;

function write(messages: ClaudeMessage[], tag: string): Promise<DraftContent> {
  calls++;
  return claudeJson(env, {
    model,
    system: writerSystem,
    cacheSystem: true,
    messages,
    schema: DRAFT_SCHEMA,
    maxTokens: DRAFT_MAX_TOKENS,
    deadline: Date.now() + CALL_BUDGET_MS,
    parse: parseDraftContent,
    label: tag,
  });
}

function review(c: DraftContent, tag: string): Promise<StyleReview> {
  calls++;
  return claudeJson(env, {
    model,
    system: reviewerSystem,
    cacheSystem: true,
    messages: [{ role: 'user', content: reviewUser(c) }],
    schema: REVIEW_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
    deadline: Date.now() + CALL_BUDGET_MS,
    parse: parseReview,
    label: tag,
  });
}

const machineIssues = (c: DraftContent) => [...checkDraftLimits(c).filter((v) => v.hard), ...checkStyle(c)];

interface IdeaResult {
  id: string;
  first: { passed: number; failed: string[]; banned: string[] };
  final: { passed: number; failed: string[]; banned: string[]; evidence: Record<string, string> };
  rewritten: boolean;
  x_first_tweet: string;
  linkedin_opening: string;
  error?: string;
}

async function evaluate(idea: EvalIdea, index: number): Promise<IdeaResult> {
  const messages: ClaudeMessage[] = [{ role: 'user', content: draftUser({ id: index + 1, text: idea.text, pillar: idea.pillar }, []) }];
  let draft = await write(messages, `eval_${idea.id}`);
  const issues = machineIssues(draft);
  if (issues.length) draft = await write([...messages, ...fixViolationsTurn(draft, issues)], `eval_${idea.id}_fix`);
  const firstReview = await review(draft, `eval_${idea.id}_review`);
  const summary = (c: DraftContent, r: StyleReview) => ({
    passed: r.passed,
    failed: r.failed.map((f) => f.id),
    banned: checkStyle(c).map((v) => v.message),
  });
  const first = summary(draft, firstReview);

  let final = draft;
  let finalReview = firstReview;
  if (firstReview.failed.length) {
    const second = await write([...messages, ...reviewFixTurn(draft, firstReview)], `eval_${idea.id}_review_fix`);
    const secondReview = await review(second, `eval_${idea.id}_review2`);
    // القاعدة نفسها في البوت: لا تُقبل نسخة بمخالفات آلية أكثر، ثم الأقل في بنود المدقّق
    const rank = (c: DraftContent, r: StyleReview) => machineIssues(c).length * 10 + r.failed.length;
    if (rank(second, secondReview) <= rank(draft, firstReview)) {
      final = second;
      finalReview = secondReview;
    }
  }
  return {
    id: idea.id,
    first,
    final: { ...summary(final, finalReview), evidence: Object.fromEntries(finalReview.failed.map((f) => [f.id, f.evidence])) },
    rewritten: final !== draft,
    x_first_tweet: final.x_segments[0] ?? '',
    linkedin_opening: final.linkedin_text.split('\n')[0] ?? '',
  };
}

// ---------- التقرير ----------

interface RunFile {
  at: string;
  label: string;
  model: string;
  total_criteria: number;
  ideas: IdeaResult[];
  summary: { first_avg: number; final_avg: number; criteria_pass_rate: Record<string, number>; banned_final: number };
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function summarize(results: IdeaResult[]): RunFile['summary'] {
  const ok = results.filter((r) => !r.error);
  const rate = Object.fromEntries(
    REVIEW_CRITERIA.map((c) => [c.id, ok.length ? ok.filter((r) => !r.final.failed.includes(c.id)).length / ok.length : 0]),
  );
  return {
    first_avg: avg(ok.map((r) => r.first.passed)),
    final_avg: avg(ok.map((r) => r.final.passed)),
    criteria_pass_rate: rate,
    banned_final: ok.reduce((n, r) => n + r.final.banned.length, 0),
  };
}

function previousRun(dir: URL): RunFile | null {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(new URL(last, dir), 'utf8')) as RunFile) : null;
}

function report(run: RunFile, prev: RunFile | null): string {
  const total = run.total_criteria;
  const label = (id: string) => REVIEW_CRITERIA.find((c) => c.id === id)?.label ?? id;
  const lines = [`نموذج ${run.model}${run.label ? `، ${run.label}` : ''}، ${run.ideas.length} فكرة`, ''];
  for (const r of run.ideas) {
    if (r.error) {
      lines.push(`فكرة ${r.id}: تعذّر التقييم (${r.error})`);
      continue;
    }
    const missing = r.final.failed.map(label).join('، ');
    lines.push(
      `فكرة ${r.id}: أولى ${r.first.passed}/${total} ← نهائية ${r.final.passed}/${total}${missing ? `، لم يتحقق: ${missing}` : ''}${
        r.final.banned.length ? `، ${r.final.banned.join('، ')}` : ''
      }`,
    );
  }
  const s = run.summary;
  lines.push('', `المتوسط: المسودة الأولى ${s.first_avg}/${total}، والنهائية ${s.final_avg}/${total}`);
  if (prev) {
    const d = (a: number, b: number) => `${a - b >= 0 ? '+' : ''}${Math.round((a - b) * 100) / 100}`;
    lines.push(
      `مقارنة بتشغيل ${prev.at}${prev.label ? ` (${prev.label})` : ''}: الأولى ${d(s.first_avg, prev.summary.first_avg)}، والنهائية ${d(s.final_avg, prev.summary.final_avg)}`,
    );
  }
  lines.push('', 'نسبة النجاح في كل بند (المسودة النهائية):');
  for (const c of REVIEW_CRITERIA) {
    const now = s.criteria_pass_rate[c.id] ?? 0;
    const before = prev?.summary.criteria_pass_rate[c.id];
    lines.push(`- ${c.label}: ${pct(now)}${before === undefined ? '' : ` (كانت ${pct(before)})`}`);
  }
  lines.push(`عبارات ممنوعة بقيت في المسودات النهائية: ${s.banned_final}`);
  return lines.join('\n');
}

// ---------- التشغيل ----------

async function main(): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) {
    console.error('اضبط ANTHROPIC_API_KEY أولاً.');
    process.exit(1);
  }
  const ideas = parseIdeas(read('eval/ideas.md')).filter((i) => !only || only.includes(i.id));
  if (ideas.length === 0) {
    console.error('لا أفكار في eval/ideas.md (أو لا يطابق --only شيئاً).');
    process.exit(1);
  }
  console.log(`أقيّم ${ideas.length} فكرة بالنموذج ${model}…`);
  const results: IdeaResult[] = new Array(ideas.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ideas.length) }, async () => {
      while (next < ideas.length) {
        const i = next++;
        const idea = ideas[i] as EvalIdea;
        try {
          results[i] = await evaluate(idea, i);
        } catch (err) {
          const empty = { passed: 0, failed: [], banned: [] };
          results[i] = {
            id: idea.id,
            first: empty,
            final: { ...empty, evidence: {} },
            rewritten: false,
            x_first_tweet: '',
            linkedin_opening: '',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        console.log(`  فكرة ${idea.id}: تمت`);
      }
    }),
  );

  const dir = new URL('eval/results/', root);
  mkdirSync(dir, { recursive: true });
  const prev = only ? null : previousRun(dir); // المقارنة لا تصح على جزء من المجموعة
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const run: RunFile = { at, label, model, total_criteria: REVIEW_CRITERIA.length, ideas: results, summary: summarize(results) };
  if (!only) writeFileSync(new URL(`${at.replace(/:/g, '-')}.json`, dir), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`\n${report(run, prev)}\n\nعدد الطلبات: ${calls}${only ? '\n(تشغيل جزئي بـ --only: لم يُحفظ ولم يُقارن)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
