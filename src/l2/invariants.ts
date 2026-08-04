import type { Message } from './types.js';

export class TranscriptInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptInvariantError';
  }
}

/**
 * The rules the API enforces, checked locally so eviction bugs surface in CI instead of
 * as a 400 at 2am inside a retry loop.
 *
 *  - roles alternate
 *  - every tool_use is answered by a tool_result with a matching id
 *  - the answer is in the IMMEDIATELY following user message
 *  - if the assistant emitted N parallel tool_use blocks, all N results come back. Not N-1.
 */
export function assertWellFormed(messages: Message[]): void {
  let pending = new Set<string>();
  let expectedRole: 'user' | 'assistant' | null = null;

  for (const [i, msg] of messages.entries()) {
    if (expectedRole && msg.role !== expectedRole) {
      throw new TranscriptInvariantError(
        `msg[${i}]: role ${msg.role} where ${expectedRole} was required (roles must alternate)`,
      );
    }
    expectedRole = msg.role === 'user' ? 'assistant' : 'user';

    if (msg.role === 'assistant') {
      if (pending.size) {
        throw new TranscriptInvariantError(`msg[${i}]: assistant turn while ${pending.size} tool_use still unanswered`);
      }
      for (const b of msg.content) if (b.type === 'tool_use') pending.add(b.id);
      continue;
    }

    const answered = new Set<string>();
    for (const b of msg.content) {
      if (b.type !== 'tool_result') continue;
      if (!pending.has(b.tool_use_id)) {
        throw new TranscriptInvariantError(`msg[${i}]: orphan tool_result ${b.tool_use_id}`);
      }
      answered.add(b.tool_use_id);
    }
    for (const id of pending) {
      if (!answered.has(id)) {
        throw new TranscriptInvariantError(`msg[${i}]: missing tool_result for ${id}`);
      }
    }
    pending = new Set();
  }

  if (pending.size) {
    throw new TranscriptInvariantError(`transcript ends with unanswered tool_use: ${[...pending].join(', ')}`);
  }
}

export function isWellFormed(messages: Message[]): boolean {
  try {
    assertWellFormed(messages);
    return true;
  } catch {
    return false;
  }
}

/**
 * Indices at which `messages.slice(i)` is free of orphan tool_results.
 *
 *   - an assistant message is always safe: assistant turns never CONTAIN a tool_result,
 *     and the results for their tool_use blocks follow them.
 *   - a user message is safe only if it carries no tool_result.
 *
 * Consequence: a single agent turn with 30 tool calls is ATOMIC. You can drop the whole
 * pair, never half of it. If one turn exceeds the budget, no eviction policy saves you —
 * L3 must spill the result (see src/l3/spill.ts).
 *
 * Note the second-order constraint this creates: cutting at an assistant index leaves a
 * transcript that starts with an assistant message, which the API rejects. That is what
 * the rollup bridge in ConversationBuffer is for.
 */
export function safeCutPoints(messages: Message[]): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      cuts.push(i);
      continue;
    }
    if (!m.content.some((b) => b.type === 'tool_result')) cuts.push(i);
  }
  return cuts;
}

/** Indices that would split a tool_use/tool_result pair. The illustrative inverse. */
export function unsafeCutPoints(messages: Message[]): number[] {
  const safe = new Set(safeCutPoints(messages));
  return messages.map((_, i) => i).filter((i) => !safe.has(i));
}
