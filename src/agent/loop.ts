import type { RunContext } from '../l1/run-context.js';
import { ConversationBuffer, type BufferOptions, DEFAULT_BUFFER_OPTIONS, InMemoryArchive } from '../l2/buffer.js';
import { assertWellFormed } from '../l2/invariants.js';
import { HeuristicSummarizer } from '../l2/rollup.js';
import { userText, type Message } from '../l2/types.js';
import { runToolBatch } from '../l3/executor.js';
import { ToolCallRegistry, type ToolUse } from '../l3/registry.js';
import { SpillStore } from '../l3/spill.js';
import { idempotencyKey, InMemoryStepLog, type StepLog } from '../l3/steplog.js';
import { pack, type MemoryStore } from '../l4/store.js';
import type { ModelClient } from '../model/client.js';
import type { ToolRegistry } from '../tools/index.js';

export interface AgentOptions {
  system: string;
  model: ModelClient;
  tools: ToolRegistry;
  spill: SpillStore;
  store?: MemoryStore;
  buffer?: Partial<BufferOptions>;
  stepLog?: StepLog;
  maxSteps?: number;
  /** Set false to reproduce the strawman: no retrieval at all. */
  retrieval?: boolean;
  retrievalBudget?: number;
  onStep?: (info: StepInfo) => void;
  /** Act 5: throw after this step to demonstrate crash + resume. */
  crashAtStep?: number;
}

export interface StepInfo {
  step: number;
  bufferTokens: number;
  evictions: number;
  inflight: number;
  orphaned: number;
  hitRate: number;
  costUsd: number;
  toolNames: string[];
}

export class CrashInjected extends Error {
  constructor(step: number) {
    super(`injected crash at step ${step}`);
    this.name = 'CrashInjected';
  }
}

export interface AgentResult {
  text: string;
  steps: number;
  buffer: ConversationBuffer;
}

/**
 * The loop that ties the four layers together.
 *
 *   L1 owns the run context, the budget and the cancellation tree
 *   L2 owns the window and its eviction policy
 *   L3 owns the tool state machine and spilling
 *   L4 owns retrieval and the fact store
 */
export async function runAgent(ctx: RunContext, prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const bufferOpts = { ...DEFAULT_BUFFER_OPTIONS, ...opts.buffer };
  const buffer = new ConversationBuffer(bufferOpts, new HeuristicSummarizer(), new InMemoryArchive());
  const stepLog = opts.stepLog ?? new InMemoryStepLog();

  using registry = new ToolCallRegistry({ maxInflight: 8, maxTotalBytes: 64 << 20 });

  // L4 -> L2: retrieved context goes BELOW the stable prefix, near the current turn.
  // Putting it up top costs you the cache on every single turn.
  if (opts.retrieval !== false && opts.store) {
    const hits = await opts.store.retrieve(prompt, {
      limit: 5,
      exclude: buffer.docIdsMentioned(), // never pay twice for tokens already in the window
    });
    ctx.metrics.retrievals++;
    buffer.append({
      role: 'user',
      content: [{ type: 'text', text: pack(hits, opts.retrievalBudget ?? 2_000) }],
      meta: { kind: 'retrieval' },
    });
    buffer.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Context noted.' }],
      meta: { kind: 'retrieval' },
    });
  }

  buffer.append(userText(prompt));

  const maxSteps = opts.maxSteps ?? 24;
  let finalText = '';
  let step = 0;

  for (; step < maxSteps; step++) {
    ctx.signal.throwIfAborted();

    const messages = await buffer.fit();
    assertWellFormed(messages);

    const res = await opts.model.send({
      system: opts.system,
      messages,
      tools: opts.tools.definitions(),
      // Breakpoint at the END of the existing transcript: the whole prefix up to here is
      // cacheable, and only the new turn is written. This is what makes prefix STABILITY
      // the thing that matters — see act2.
      cacheBreakpoint: messages.length - 1,
    });
    ctx.metrics.modelCalls++;
    ctx.metrics.cacheReadTokens += res.usage.cache_read_input_tokens;
    ctx.metrics.cacheWriteTokens += res.usage.cache_creation_input_tokens;
    ctx.metrics.promptTokens += res.usage.input_tokens;

    buffer.append({ role: 'assistant', content: res.content, meta: { turn: step } });

    const uses: ToolUse[] = res.content
      .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    if (!uses.length) {
      finalText = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      break;
    }

    // Write-ahead step log: log BEFORE dispatch, update after. Order matters.
    for (const use of uses) {
      await stepLog.append({
        runId: ctx.runId,
        stepIndex: step,
        toolUseId: use.id,
        toolName: use.name,
        inputHash: '',
        idempotencyKey: idempotencyKey(ctx.runId, step, use.name, JSON.stringify(use.input)),
        status: 'started',
        ts: Date.now(),
      });
    }

    // Crash injected BETWEEN the write-ahead log and the result records — the interesting
    // case for resume: steps that started but never completed.
    if (opts.crashAtStep !== undefined && step === opts.crashAtStep) throw new CrashInjected(step);

    const results = await runToolBatch(uses, ctx, { tools: opts.tools, registry, spill: opts.spill }, step);

    for (const use of uses) {
      const rec = registry.get(use.id);
      await stepLog.append({
        runId: ctx.runId,
        stepIndex: step,
        toolUseId: use.id,
        toolName: use.name,
        inputHash: rec?.inputHash ?? '',
        idempotencyKey: idempotencyKey(ctx.runId, step, use.name, JSON.stringify(use.input)),
        status: rec?.state === 'ok' ? 'ok' : 'error',
        resultRef: rec?.resultRef,
        ts: Date.now(),
      });
    }

    buffer.append({ role: 'user', content: results, meta: { turn: step } });

    opts.onStep?.({
      step,
      bufferTokens: buffer.tokens,
      evictions: buffer.evictions,
      inflight: registry.stats.inflight,
      orphaned: registry.stats.orphaned,
      hitRate: opts.model.hitRate,
      costUsd: opts.model.costUsd,
      toolNames: uses.map((u) => u.name),
    });
  }

  return { text: finalText, steps: step + 1, buffer };
}

/** The strawman from act0: messages.push in a loop, no eviction, no lifecycle. */
export async function runStrawman(
  prompt: string,
  opts: Pick<AgentOptions, 'system' | 'model' | 'tools' | 'spill'> & {
    maxSteps?: number;
    /** Fires after each turn is appended — how act0 shows the transcript growing in real time. */
    onTurn?: (turn: number, messages: Message[]) => void;
    /** Continue a prior runStrawman() conversation instead of starting fresh. */
    history?: Message[];
  },
): Promise<{ messages: Message[]; text: string }> {
  const messages: Message[] = [...(opts.history ?? []), userText(prompt)];
  let text = '';

  for (let i = 0; i < (opts.maxSteps ?? 24); i++) {
    const res = await opts.model.send({ system: opts.system, messages, tools: opts.tools.definitions() });
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) {
      text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      opts.onTurn?.(i, messages);
      break;
    }

    const results = [];
    for (const u of uses) {
      if (u.type !== 'tool_use') continue;
      const tool = opts.tools.get(u.name);
      try {
        if (!tool) throw new Error(`no such tool: ${u.name}`);
        const out = await tool.run(tool.schema.parse(u.input) as never, {
          signal: AbortSignal.timeout(30_000),
          ctx: null as never,
        });
        // The strawman inlines the ENTIRE result. This is the bug.
        results.push({
          type: 'tool_result' as const,
          tool_use_id: u.id,
          content: Buffer.isBuffer(out) ? out.toString('utf8') : String(out),
        });
      } catch (err) {
        // A tool call failing (bad input, a bogus ref, whatever) must never crash the
        // loop — it comes back as an error result so the model can see what went wrong
        // and adjust, same as the real API's tool_result.is_error contract.
        results.push({
          type: 'tool_result' as const,
          tool_use_id: u.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
    opts.onTurn?.(i, messages);
  }

  return { messages, text };
}
