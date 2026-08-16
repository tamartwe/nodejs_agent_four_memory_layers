import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  fakeModelCall,
  searchFlights,
} from './fake-tools';
import {
  heapMb,
  rssMb,
} from './memory-metrics';
import type {
  DemoMetrics,
  RawFlightSearchResponse,
} from './types';
import { banner, kv } from '../lib/report';

interface UnsafeTraceHandle {
  id: string;
  startedAt: number;
  tags: Map<string, string>;
}

interface UnsafeTraceEntry {
  step: number;
  toolName: string;
  rawResponse: RawFlightSearchResponse;
}

interface UnsafeRunContext {
  runId: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  currentStep: number;
  scratchpad: string[];
  partialModelOutput: string;
  rawToolResponses: RawFlightSearchResponse[];
  cache: Map<string, string>;
  trace: UnsafeTraceEntry[];
  traceHandles: UnsafeTraceHandle[];
  timers: NodeJS.Timeout[];
}

interface UnsafeRunOptions {
  runId: string;
  prompt?: string;
  plannedToolSteps?: number;
  timeoutMs?: number;
  failModelAtStep?: number;
}

export const unsafeRunRegistry = new Map<string, UnsafeRunContext>();
export const unsafePersistedRuns = new Map<string, string>();
export const unsafeActiveTimers = new Set<NodeJS.Timeout>();
export const unsafeTraceBus = new EventEmitter();

unsafeTraceBus.setMaxListeners(0);

function serializeWholeContext(context: UnsafeRunContext): string {
  return JSON.stringify({
    ...context,
    cache: [...context.cache.entries()],
    timers: context.timers.map((timer) => String(timer)),
    traceHandles: context.traceHandles.map((handle) => ({
      id: handle.id,
      startedAt: handle.startedAt,
      tags: [...handle.tags.entries()],
    })),
  });
}

async function executeUnsafeContext(
  context: UnsafeRunContext,
  { plannedToolSteps = 3, failModelAtStep }: UnsafeRunOptions,
): Promise<string> {
  while (context.status === 'running') {
    context.currentStep += 1;

    const decision = await fakeModelCall({
      step: context.currentStep,
      plannedToolSteps,
      failAtStep: failModelAtStep,
    });

    if (decision.kind === 'final') {
      context.status = 'completed';
      context.partialModelOutput = decision.text;
      unsafePersistedRuns.set(context.runId, serializeWholeContext(context));
      return decision.text;
    }

    const rawResponse = await searchFlights(decision.input, {
      candidateCount: 90,
      responsePaddingBytes: 224,
    });

    context.rawToolResponses.push(rawResponse);
    context.trace.push({
      step: context.currentStep,
      toolName: decision.toolName,
      rawResponse,
    });

    rawResponse.candidates.forEach((candidate) => {
      context.cache.set(`${context.runId}:${candidate.id}:${context.currentStep}`, candidate.rawFareRules);
    });
    context.scratchpad.push(`step ${context.currentStep}: received ${rawResponse.candidates.length} flights`);
  }

  throw new Error(`run ${context.runId} stopped unexpectedly`);
}

export async function runUnsafeAgent(options: UnsafeRunOptions): Promise<string> {
  const context: UnsafeRunContext = {
    runId: options.runId,
    prompt: options.prompt ?? 'Find the cheapest flight from TLV to BER.',
    status: 'running',
    createdAt: Date.now(),
    currentStep: 0,
    scratchpad: [],
    partialModelOutput: '',
    rawToolResponses: [],
    cache: new Map(),
    trace: [],
    traceHandles: [],
    timers: [],
  };

  unsafeRunRegistry.set(context.runId, context);

  const heartbeat = setInterval(() => {
    context.scratchpad.push(`heartbeat ${Date.now()}`);
  }, 30_000);
  heartbeat.unref?.();
  context.timers.push(heartbeat);
  unsafeActiveTimers.add(heartbeat);

  const traceHandle: UnsafeTraceHandle = {
    id: `trace-${context.runId}`,
    startedAt: Date.now(),
    tags: new Map([['runId', context.runId]]),
  };
  context.traceHandles.push(traceHandle);

  unsafeTraceBus.on('client:disconnect', () => {
    context.scratchpad.push('client disconnected, but child work was not cancelled');
  });

  const execution = executeUnsafeContext(context, options);

  if (!options.timeoutMs) {
    return execution;
  }

  return Promise.race([
    execution,
    new Promise<string>((_, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`parent timed out after ${options.timeoutMs}ms; child work still running`));
      }, options.timeoutMs);
      timeout.unref?.();
    }),
  ]);
}

export function resetUnsafeState(): void {
  unsafeActiveTimers.forEach((timer) => clearInterval(timer));
  unsafeActiveTimers.clear();
  unsafeRunRegistry.clear();
  unsafePersistedRuns.clear();
  unsafeTraceBus.removeAllListeners();
}

export function collectUnsafeMetrics(label = 'before'): DemoMetrics {
  const contexts = [...unsafeRunRegistry.values()];
  return {
    label,
    completedRuns: contexts.filter((context) => context.status === 'completed').length,
    activeRunRegistryEntries: unsafeRunRegistry.size,
    heapMb: heapMb(),
    rssMb: rssMb(),
    retainedRawToolResponses: contexts.reduce(
      (total, context) => total + context.rawToolResponses.length,
      0,
    ),
    persistedBytes: [...unsafePersistedRuns.values()].reduce(
      (total, snapshot) => total + Buffer.byteLength(snapshot),
      0,
    ),
    activeTimers: unsafeActiveTimers.size,
    activeTraceHandles: contexts.reduce((total, context) => total + context.traceHandles.length, 0),
    cacheEntries: contexts.reduce((total, context) => total + context.cache.size, 0),
  };
}

async function runBeforeDemo(): Promise<void> {
  resetUnsafeState();
  const runs = Number(process.env.RUNS ?? 12);

  banner('Demo 1 - working memory before', 'before');
  for (let index = 0; index < runs; index += 1) {
    await runUnsafeAgent({ runId: `before-${index}` });
    const metrics = collectUnsafeMetrics();
    process.stdout.write(
      `run ${String(index + 1).padStart(2)}  registry=${String(metrics.activeRunRegistryEntries).padStart(2)}`
        + `  raw=${String(metrics.retainedRawToolResponses).padStart(3)}`
        + `  cache=${String(metrics.cacheEntries).padStart(4)}`
        + `  persisted=${String(metrics.persistedBytes).padStart(8)} bytes`
        + `  heap=${metrics.heapMb.toFixed(1)} MB\n`,
    );
  }

  kv({ ...collectUnsafeMetrics() });
  console.log(
    '\nThe leak is deterministic: completed run contexts remain reachable from the process-global Map.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runBeforeDemo();
}
