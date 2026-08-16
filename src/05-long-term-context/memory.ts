import { callModel, CHEAP_MODEL, type UsageMeter } from '../lib/client';

/**
 * STRUCTURING LONG-TERM CONTEXT
 *
 * The failure that breaks append-only memory is not retrieval quality.
 * It is CONTRADICTION.
 *
 *   turn 4:  "the rollback window is 40 minutes"
 *   turn 19: "we shortened the rollback window to 15 minutes"
 *
 * Append both, embed both, and every future retrieval returns both. The model
 * now picks one at random, and it will sound equally confident either way.
 * No amount of reranking fixes this, because both chunks ARE relevant.
 *
 * The fix is not a better retriever. It is a schema:
 *
 *   { subject, predicate, value, confidence, source, validFrom, validTo }
 *
 * Same (subject, predicate) arriving again does not append — it SUPERSEDES.
 * The old record gets a validTo and drops out of the default view. You keep
 * the history for audit; you retrieve only what is currently true.
 */

export type FactKind = 'constraint' | 'identifier' | 'config' | 'decision';

export interface FactInput {
  subject: string;
  predicate: string;
  value: string;
  kind: FactKind;
}

export interface FactRecord extends FactInput {
  id: string;
  source: { runId: string; turn: number };
  validFrom: number;
  validTo: number | null;
  hits?: number;
}

export interface RankedFactRecord extends FactRecord {
  rankScore: number;
}

export interface MemoryStats {
  written: number;
  superseded: number;
  duplicates: number;
}

export class StructuredMemory {
  records: FactRecord[] = []; // append-only log

  current = new Map<string, FactRecord>(); // "subject|predicate" -> record  (the live view)

  stats: MemoryStats = { written: 0, superseded: 0, duplicates: 0 };

  #key(r: { subject: string; predicate: string }): string {
    return `${r.subject.toLowerCase()}|${r.predicate.toLowerCase()}`;
  }

  write(rec: FactInput, { runId, turn }: { runId: string; turn: number }): FactRecord {
    const r: FactRecord = {
      ...rec,
      id: `m${this.records.length + 1}`,
      source: { runId, turn },
      validFrom: turn,
      validTo: null,
    };
    const key = this.#key(r);
    const prev = this.current.get(key);

    if (prev) {
      if (String(prev.value).toLowerCase() === String(r.value).toLowerCase()) {
        // Reinforcement, not a new fact. Bump confidence, do not duplicate.
        prev.hits = (prev.hits ?? 1) + 1;
        this.stats.duplicates += 1;
        return prev;
      }
      prev.validTo = turn; // ← the line that stops contradictions retrieving
      this.stats.superseded += 1;
    }

    this.records.push(r);
    this.current.set(key, r);
    this.stats.written += 1;
    return r;
  }

  /** Only currently-true records. Superseded ones are auditable, not retrievable. */
  live(): FactRecord[] {
    return [...this.current.values()].filter((r) => r.validTo === null);
  }

  history(subject: string, predicate: string): FactRecord[] {
    return this.records.filter(
      (r) => r.subject.toLowerCase() === subject.toLowerCase()
             && r.predicate.toLowerCase() === predicate.toLowerCase(),
    );
  }

  /**
   * Ranking for retrieval: recency and reinforcement, not similarity alone.
   * A fact stated three times and restated recently outranks a stale one-off,
   * even when cosine says otherwise.
   */
  rank(candidates: FactRecord[], { now }: { now: number }): RankedFactRecord[] {
    return candidates
      .map((r) => ({
        ...r,
        rankScore:
          (r.hits ?? 1) * 1.0 // reinforcement
          + 1 / (1 + (now - r.validFrom) * 0.05) // recency decay
          + (r.kind === 'constraint' ? 0.5 : 0), // constraints outrank trivia
      }))
      .sort((a, b) => b.rankScore - a.rankScore);
  }
}

/**
 * WRITE PATH. Extraction runs on the cheap model, on the turn that just
 * happened — not on the whole transcript at the end. Two rules matter:
 *   - extract facts the USER asserted, never advice the assistant gave
 *   - emit nothing rather than emit something weak
 */
export async function extractFacts(
  userTurn: string,
  assistantText: string,
  meter: UsageMeter | undefined,
): Promise<FactInput[]> {
  const res = await callModel(meter, {
    model: CHEAP_MODEL,
    max_tokens: 400,
    system:
      'Extract durable facts a colleague would still need next month. Output a JSON array of '
      + '{subject, predicate, value, kind} where kind is one of: constraint, identifier, config, decision. '
      + 'Rules: (1) only facts the USER asserted — never the assistant\'s suggestions or analysis. '
      + '(2) subject+predicate must be stable, so a later correction overwrites this one '
      + '(good: subject="CR-88214", predicate="rollback_window"). '
      + '(3) skip anything transient, conversational, or hypothetical. '
      + '(4) if nothing durable was said, return []. Output only the JSON array.',
    messages: [
      { role: 'user', content: `USER SAID: ${userTurn}\n\nASSISTANT REPLIED: ${assistantText.slice(0, 600)}` },
    ],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '[]';
  try {
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as unknown[];
    return Array.isArray(arr)
      ? (arr.filter(
        (r): r is FactInput => typeof r === 'object' && r !== null
          && 'subject' in r && 'predicate' in r && 'value' in r
          && (r as FactInput).subject !== undefined
          && (r as FactInput).value !== undefined,
      ))
      : [];
  } catch {
    return [];
  }
}
