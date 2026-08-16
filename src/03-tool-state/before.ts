/**
 * LAYER 3 — TOOL CALL STATE · BEFORE
 *
 * Tool state is the layer people do not know they have. It is:
 *   - the in-flight map keyed by tool_use_id
 *   - the raw result payloads
 *   - the retry/timeout bookkeeping
 *
 * Three bugs here, and the third is the expensive one:
 *
 *   B1  pendingCalls.delete() only on the success path. Every throw,
 *       timeout or abort leaves an entry behind — forever.
 *   B2  the raw payload is retained THREE times: in pendingCalls, in
 *       resultCache, and serialised into the messages array.
 *   B3  full tool results stay in the transcript for every subsequent
 *       step, so a 600-row telemetry dump is re-sent on step 4, 5, 6...
 *
 * The workflow deliberately includes a tool that fails, because that is the
 * path nobody tests.
 *
 * run: npm run demo:3:before
 */
import type Anthropic from '@anthropic-ai/sdk';
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { TOOL_DEFS, runTool, type ToolResult } from '../lib/tools';
import {
  banner, kv, HeapTrace, bytes, sizeOf,
} from '../lib/report';
import { WORKFLOW } from './workflow';

interface PendingEntry {
  name: string;
  input: unknown;
  startedAt: number;
  timer: NodeJS.Timeout;
}

// Module-scope, shared across every run. Both of these only grow.
const pendingCalls = new Map<string, PendingEntry>();
const resultCache = new Map<string, ToolResult>();

async function executeTool(use: Anthropic.ToolUseBlock): Promise<ToolResult> {
  pendingCalls.set(use.id, {
    name: use.name,
    input: use.input,
    startedAt: Date.now(),
    timer: setTimeout(() => {}, 120_000), // B1: never cleared on the error path
  });

  const out = await runTool(use.name, use.input); // ← may throw

  resultCache.set(use.id, out); // B2: second copy of the payload
  pendingCalls.delete(use.id); // ← unreachable when runTool throws
  return out;
}

async function runWorkflow(prompt: string, meter: UsageMeter): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

  for (let step = 0; step < 12; step += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await callModel(meter, {
      model: MODEL,
      max_tokens: 1024,
      system: 'You are an ops agent. Work through the request step by step using tools.',
      tools: TOOL_DEFS,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') break;

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results: Anthropic.ToolResultBlockParam[] = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const use of uses) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await executeTool(use);
        // B3: the entire payload goes into the transcript and stays there
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out),
        });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: String((err as Error).message),
        });
      }
    }
    messages.push({ role: 'user', content: results });

    process.stdout.write(
      `    step ${String(step + 1).padStart(2)}  tools=${uses.map((u) => u.name).join(',')}`
        + `  pending=${String(pendingCalls.size).padStart(3)}`
        + `  transcript=${bytes(sizeOf(messages)).padStart(9)}`
        + `  input=${res.usage.input_tokens} tok\n`,
    );
  }
  return messages;
}

// ─────────────────────────────────────────────────────────────────────────
banner('Layer 3 — tool call state', 'before');
const meter = new UsageMeter('L3-before');
const trace = new HeapTrace('before');
trace.sample('start');

// eslint-disable-next-line no-restricted-syntax
for (const [i, prompt] of WORKFLOW.entries()) {
  console.log(`\n  workflow ${i + 1}: ${prompt.slice(0, 70)}…`);
  // eslint-disable-next-line no-await-in-loop
  await runWorkflow(prompt, meter);
  trace.sample(`wf ${i + 1}`);
}

trace.print();
kv({
  'pendingCalls left behind': pendingCalls.size,
  'resultCache entries': resultCache.size,
  'resultCache bytes': bytes(sizeOf([...resultCache.values()])),
  'live timers': process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length,
  ...meter.summary(),
});
console.log(
  '\n  pendingCalls should be 0. Every entry above is a tool call that failed\n'
    + '  and never got cleaned up — holding its input, its timer, and its closure.\n',
);
process.exit(0);
