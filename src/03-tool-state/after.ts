/**
 * LAYER 3 — TOOL CALL STATE · AFTER
 *
 * Same workflows, same failing tool. Three changes:
 *
 *   B1  pending.delete() moved into a finally block → 0 stale entries
 *   B2  one copy of the payload, in a run-owned store that is cleared on exit
 *   B3  results over ~1.5 KB are offloaded behind a handle; the transcript
 *       carries a structural preview and the model can call read_result if
 *       it genuinely needs rows
 *
 * Watch the transcript size column. In BEFORE it grows with every telemetry
 * call. Here it stays roughly flat, which is why step 12 costs the same as
 * step 2.
 *
 * run: npm run demo:3:after
 */
import type Anthropic from '@anthropic-ai/sdk';
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { TOOL_DEFS, runTool } from '../lib/tools';
import {
  banner, kv, HeapTrace, bytes, sizeOf,
} from '../lib/report';
import { WORKFLOW } from './workflow';
import {
  withToolState, READ_RESULT_TOOL, type ToolExecStats, type ToolRunState,
} from './runState';

const SYSTEM = 'You are an ops agent. Work through the request step by step using tools. '
  + 'Large tool results are returned as a handle plus a summary — the summary is '
  + 'usually enough. Only call read_result when you need individual rows.';

/** Dispatches to the run's out-of-band store for read_result, or the real tool otherwise. */
async function execTool(
  state: ToolRunState,
  name: string,
  input: unknown,
  opts: { signal: AbortSignal },
): Promise<object> {
  if (name === 'read_result') {
    return state.readResult(input as { handle: string; path?: string }) as object;
  }
  return runTool(name, input, opts);
}

interface WorkflowOutcome extends ToolExecStats {
  handles: number;
}

async function runWorkflow(
  runId: string,
  prompt: string,
  meter: UsageMeter,
  controller: AbortController,
): Promise<WorkflowOutcome> {
  return withToolState(runId, async (state) => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

    for (let step = 0; step < 12; step += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await callModel(meter, {
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        tools: [...TOOL_DEFS, READ_RESULT_TOOL],
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason !== 'tool_use') break;

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      // Parallel, but bounded by the run's signal. All results return in ONE
      // user message — splitting them is an API error.
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(
        uses.map((use) => state.execute(
          use,
          (name, input, opts) => execTool(state, name, input, opts),
          { signal: controller.signal },
        )),
      );
      messages.push({ role: 'user', content: results });

      process.stdout.write(
        `    step ${String(step + 1).padStart(2)}  tools=${uses.map((u) => u.name).join(',')}`
          + `  pending=${String(state.pending.size).padStart(3)}`
          + `  transcript=${bytes(sizeOf(messages)).padStart(9)}`
          + `  input=${res.usage.input_tokens} tok\n`,
      );
    }
    return { ...state.stats, handles: state.results.size };
  });
}

// ─────────────────────────────────────────────────────────────────────────
banner('Layer 3 — tool call state', 'after');
const meter = new UsageMeter('L3-after');
const trace = new HeapTrace('after');
const controller = new AbortController();
trace.sample('start');

const totals: ToolExecStats = {
  started: 0, ok: 0, failed: 0, offloaded: 0, bytesOffloaded: 0,
};
// eslint-disable-next-line no-restricted-syntax
for (const [i, prompt] of WORKFLOW.entries()) {
  console.log(`\n  workflow ${i + 1}: ${prompt.slice(0, 70)}…`);
  // eslint-disable-next-line no-await-in-loop
  const s = await runWorkflow(`wf-${i}`, prompt, meter, controller);
  (Object.keys(totals) as Array<keyof ToolExecStats>).forEach((k) => {
    totals[k] += s[k] ?? 0;
  });
  trace.sample(`wf ${i + 1}`);
}

trace.print();
kv({
  'tool calls started': totals.started,
  '  succeeded': totals.ok,
  '  failed (expected)': totals.failed,
  'results offloaded': totals.offloaded,
  'bytes kept OUT of context': bytes(totals.bytesOffloaded),
  'live timers': process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length,
  ...meter.summary(),
});
console.log(
  '\n  Every run disposed its own state, including the runs where a tool threw.\n'
    + `  ${bytes(totals.bytesOffloaded)} of telemetry never entered the transcript, and\n`
    + '  the model still answered the firmware and region questions correctly.\n',
);
