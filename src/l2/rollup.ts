import { z } from 'zod';
import type { Message } from './types.js';

/**
 * Structured beats prose. A prose summary loses exactly what agents need: ids, paths,
 * numbers, and the options already ruled out.
 */
export const RollupSchema = z.object({
  decisions: z.array(z.object({ what: z.string(), rationale: z.string(), turn: z.number() })),
  facts: z.array(z.object({ key: z.string(), value: z.string(), source: z.string() })),
  artifacts: z.array(z.object({ ref: z.string(), role: z.string() })),
  openQuestions: z.array(z.string()),
  /** The highest-value field, and the one nobody includes. Without it the agent
   *  re-proposes the approach you vetoed 20 turns ago, because the veto got summarized away. */
  rejected: z.array(z.object({ option: z.string(), why: z.string() })),
  userPreferences: z.array(z.string()),
});

export type Rollup = z.infer<typeof RollupSchema>;

export const emptyRollup = (): Rollup => ({
  decisions: [],
  facts: [],
  artifacts: [],
  openQuestions: [],
  rejected: [],
  userPreferences: [],
});

export interface Summarizer {
  /**
   * Input is the previous STRUCTURED rollup plus the RAW evicted messages.
   * Never prose-of-prose: repeated re-summarization is a lossy compression loop and after
   * four generations the transcript describes a conversation that did not happen.
   */
  rollup(evicted: Message[], previous: Rollup | null): Promise<Rollup>;
}

export function renderRollup(r: Rollup): string {
  const lines: string[] = ['<conversation_summary>'];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`  <${title}>`);
    for (const i of items) lines.push(`    - ${i}`);
    lines.push(`  </${title}>`);
  };
  section('decisions', r.decisions.map((d) => `[turn ${d.turn}] ${d.what} — ${d.rationale}`));
  section('facts', r.facts.map((f) => `${f.key}: ${f.value} (${f.source})`));
  section('artifacts', r.artifacts.map((a) => `${a.ref} — ${a.role}`));
  section('rejected', r.rejected.map((x) => `${x.option} — ${x.why}`));
  section('open_questions', r.openQuestions);
  section('user_preferences', r.userPreferences);
  lines.push('</conversation_summary>');
  return lines.join('\n');
}

/**
 * A deterministic, offline summarizer so the demo runs on conference wifi.
 * It extracts the same STRUCTURE an LLM summarizer would produce. See LlmSummarizer
 * below for the real thing.
 */
export class HeuristicSummarizer implements Summarizer {
  async rollup(evicted: Message[], previous: Rollup | null): Promise<Rollup> {
    const out: Rollup = previous ? structuredClone(previous) : emptyRollup();

    for (const m of evicted) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          const input = JSON.stringify(b.input);
          out.facts.push({ key: `called:${b.name}`, value: input.slice(0, 120), source: 'tool_use' });
        }
        if (b.type === 'tool_result' && !b.is_error) {
          const ref = b.content.match(/ref="([^"]+)"/)?.[1];
          if (ref) out.artifacts.push({ ref, role: 'spilled tool result' });
        }
        if (b.type === 'text') {
          for (const line of b.text.split('\n')) {
            if (/^\s*(decided|we will|chose)\b/i.test(line)) {
              out.decisions.push({ what: line.trim().slice(0, 160), rationale: '', turn: m.meta?.turn ?? -1 });
            }
            if (/^\s*(rejected|ruled out|not going to|won't)\b/i.test(line)) {
              out.rejected.push({ option: line.trim().slice(0, 160), why: 'stated in conversation' });
            }
            if (/\b(always|never|prefer)\b/i.test(line) && m.role === 'user') {
              out.userPreferences.push(line.trim().slice(0, 160));
            }
          }
        }
      }
    }

    // Keep the rollup itself bounded — a summary that grows without limit is just the
    // transcript with extra steps.
    const cap = <T>(a: T[], n: number) => a.slice(-n);
    out.facts = dedupe(cap(out.facts, 40), (f) => f.key + f.value);
    out.decisions = dedupe(cap(out.decisions, 20), (d) => d.what);
    out.rejected = dedupe(cap(out.rejected, 20), (x) => x.option);
    out.artifacts = dedupe(cap(out.artifacts, 20), (a) => a.ref);
    out.userPreferences = dedupe(cap(out.userPreferences, 15), (p) => p);
    return out;
  }
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    const k = key(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}
