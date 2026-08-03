import { createHash } from 'node:crypto';
import type { ResultRef } from './spill.js';

export interface StepRecord {
  runId: string;
  stepIndex: number;
  toolUseId: string;
  toolName: string;
  inputHash: string;
  /** Derived, NOT random. randomUUID() per attempt defeats the entire mechanism — the
   *  whole point is that a retry produces the SAME key. */
  idempotencyKey: string;
  status: 'started' | 'ok' | 'error';
  resultRef?: ResultRef;
  ts: number;
}

export function idempotencyKey(
  runId: string,
  stepIndex: number,
  toolName: string,
  inputHash: string,
): string {
  return createHash('sha256').update([runId, stepIndex, toolName, inputHash].join('|')).digest('hex').slice(0, 32);
}

export interface StepLog {
  append(rec: StepRecord): Promise<void>;
  read(runId: string): Promise<StepRecord[]>;
}

export class InMemoryStepLog implements StepLog {
  private readonly records: StepRecord[] = [];
  async append(rec: StepRecord): Promise<void> {
    this.records.push({ ...rec });
  }
  async read(runId: string): Promise<StepRecord[]> {
    return this.records.filter((r) => r.runId === runId);
  }
}

export interface ResumePlan {
  completed: Map<string, StepRecord>;
  /** 'started' but never 'ok' — we crashed mid-call. The interesting case. */
  interrupted: StepRecord[];
}

/**
 * Write-ahead: log BEFORE dispatch, update after. Order matters.
 *
 * On resume:
 *   - pure / read-only tool  -> just re-run
 *   - side-effecting tool    -> re-issue with the SAME idempotency key, let the remote dedupe
 *   - non-idempotent tool    -> escalate to a human. Do not guess.
 */
export async function planResume(log: StepLog, runId: string): Promise<ResumePlan> {
  const records = await log.read(runId);
  const completed = new Map<string, StepRecord>();
  for (const r of records) if (r.status === 'ok') completed.set(r.toolUseId, r);
  const interrupted = records.filter((r) => r.status === 'started' && !completed.has(r.toolUseId));
  return { completed, interrupted };
}
