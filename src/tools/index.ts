import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { RunContext } from '../l1/run-context.js';
import type { SpillStore } from '../l3/spill.js';
import type { MemoryStore } from '../l4/store.js';
import type { ToolDefinition } from '../model/client.js';
import { buildCorpus } from '../corpus/generate.js';

export interface ToolContext {
  signal: AbortSignal;
  ctx: RunContext;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Pure/read-only tools can be safely re-run on resume. Side-effecting ones cannot. */
  sideEffecting: boolean;
  run(input: z.infer<S>, tc: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** A registry containing only the named tools — e.g. hiding L3-only tools
   *  (`read_result`, `hanging_tool`) from a caller that never spills or hangs anything. */
  subset(names: string[]): ToolRegistry {
    const r = new ToolRegistry();
    for (const name of names) {
      const t = this.tools.get(name);
      if (t) r.register(t);
    }
    return r;
  }

  /** What gets sent to the API — and re-sent on EVERY request, so it counts against the
   *  window. People forget to budget for tool definitions. */
  definitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toInputSchema(t.schema),
    }));
  }
}

/** zod -> JSON Schema, the shape `input_schema` needs for a real tool_use call. Only
 *  ScriptedModel-driven acts can get away with `{name, description}` alone. */
function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema, ...rest } = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
  return rest;
}

const corpus = buildCorpus();
const issues = new Map(corpus.chunks.map((c) => [c.docId, c]));

export interface BuildToolsDeps {
  spill: SpillStore;
  store?: MemoryStore;
  /** Simulated file sizes, so act3 can produce a real 20MB result without shipping one. */
  bigFileBytes?: number;
}

export function buildTools(deps: BuildToolsDeps): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'list_issues',
    description: 'List issue ids matching a topic keyword.',
    schema: z.object({ topic: z.string(), limit: z.number().int().min(1).max(50).default(10) }),
    sideEffecting: false,
    async run({ topic, limit }) {
      const out: string[] = [];
      for (const c of corpus.chunks) {
        if (out.length >= limit) break;
        if (c.content.toLowerCase().includes(topic.toLowerCase())) out.push(`${c.docId}: ${c.content.slice(0, 90)}`);
      }
      return out.join('\n') || `no issues matching "${topic}"`;
    },
  });

  registry.register({
    name: 'read_issue',
    description: 'Read the full text of one issue by id, e.g. ENG-4471.',
    schema: z.object({ id: z.string().regex(/^ENG-\d+$/) }),
    sideEffecting: false,
    async run({ id }) {
      const c = issues.get(id);
      if (!c) throw new Error(`no such issue: ${id}`);
      return `${c.context}\n${c.content}`;
    },
  });

  registry.register({
    name: 'search_code',
    description: 'Search the codebase for a symbol or phrase.',
    schema: z.object({ query: z.string().min(2) }),
    sideEffecting: false,
    async run({ query }) {
      return [
        `src/l3/executor.ts:41: // match for "${query}"`,
        `src/l2/buffer.ts:88: // match for "${query}"`,
        `src/l4/store.ts:63: // match for "${query}"`,
      ].join('\n');
    },
  });

  registry.register({
    name: 'read_file',
    description: 'Read a file from the repository. Large files are truncated and spilled.',
    schema: z.object({ path: z.string().min(1) }),
    sideEffecting: false,
    async run({ path }, { signal }) {
      signal.throwIfAborted();
      // Simulated large file: this is what blows up a naive transcript.
      const size = /big|dump|bundle|lock/.test(path) ? (deps.bigFileBytes ?? 20 * 1024 * 1024) : 12_000;
      const line = `// ${path} :: generated line with enough text to be realistic in a transcript\n`;
      return Buffer.alloc(size, line);
    },
  });

  registry.register({
    name: 'read_result',
    description:
      'Dereference a spilled tool result. This is the page fault: the transcript holds a pointer, this tool reads the page.',
    schema: z.object({
      ref: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(64_000).default(4_000),
    }),
    sideEffecting: false,
    async run({ ref, offset, length }) {
      return deps.spill.read(ref, offset, length);
    },
  });

  registry.register({
    name: 'run_tests',
    description: 'Run the test suite. Slow, and cancellable.',
    schema: z.object({ pattern: z.string().default('') }),
    sideEffecting: true,
    async run({ pattern }, { signal }) {
      await sleep(400, signal);
      return `ran tests matching "${pattern}": 41 passed, 0 failed`;
    },
  });

  registry.register({
    name: 'hanging_tool',
    description: 'A tool that never returns. Used by act3 to demonstrate leak class #2.',
    schema: z.object({}),
    sideEffecting: false,
    async run(_input, { signal }) {
      await sleep(60_000, signal); // cooperative: aborts when the signal fires
      return 'never';
    },
  });

  if (deps.store) {
    const { store } = deps;
    registry.register({
      name: 'search_memory',
      description: 'Hybrid search over long-term memory (lexical + vector, RRF-fused).',
      schema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(20).default(5) }),
      sideEffecting: false,
      async run({ query, limit }) {
        const hits = await store.retrieve(query, { limit });
        if (!hits.length) return 'no relevant context found';
        return hits.map((h) => `[${h.chunk.docId} ${h.chunk.date}] ${h.chunk.content}`).join('\n');
      },
    });
  }

  return registry;
}

/** Cancellable sleep: the signal must reach the timer, or cancellation is a lie. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t); // uncleared timers keep the callback AND its whole scope alive
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
