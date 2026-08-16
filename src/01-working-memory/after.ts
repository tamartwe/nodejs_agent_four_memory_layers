import { pathToFileURL } from 'node:url';
import {
  fakeModelCall,
  searchFlights,
} from './fake-tools';
import {
  bytesOf,
  heapMb,
  rssMb,
} from './memory-metrics';
import {
  activeRunRegistry,
  activeRunTimers,
  checkpointStore,
  resetSafeState,
  TraceSpan,
  withRunScope,
} from './workingMemory';
import type {
  AgentLimits,
  AgentResult,
  DemoMetrics,
  FlightSummary,
  PersistedCheckpoint,
  RawFlightSearchResponse,
} from './types';
import { DEFAULT_LIMITS } from './types';
import { banner, kv } from '../lib/report';

interface SafeRunOptions {
  runId: string;
  prompt?: string;
  limits?: Partial<AgentLimits>;
  parentSignal?: AbortSignal;
  plannedToolSteps?: number;
  neverFinal?: boolean;
  failModelAtStep?: number;
  toolLatencyMs?: number;
  candidateCount?: number;
  responsePaddingBytes?: number;
}

function checkpointFor(
  runId: string,
  status: PersistedCheckpoint['status'],
  currentStep: number,
  selectedFlightId?: string,
): PersistedCheckpoint {
  return {
    runId,
    status,
    currentStep,
    selectedFlightId,
    idempotencyKey: `book-flight:${runId}`,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

function summarizeFlights(raw: RawFlightSearchResponse): FlightSummary {
  const cheapest = raw.candidates.reduce((best, candidate) => (
    candidate.priceUsd < best.priceUsd ? candidate : best
  ));
  return {
    cheapestFlightId: cheapest.id,
    cheapestPriceUsd: cheapest.priceUsd,
    candidateCount: raw.candidates.length,
    rawBytes: bytesOf(raw),
  };
}

export async function runSafeAgent({
  runId,
  prompt = 'Find the cheapest flight from TLV to BER.',
  limits: limitOverrides = {},
  parentSignal,
  plannedToolSteps = 2,
  neverFinal = false,
  failModelAtStep,
  toolLatencyMs = 4,
  candidateCount = 90,
  responsePaddingBytes = 224,
}: SafeRunOptions): Promise<AgentResult> {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  let toolCalls = 0;
  let peakCacheEntries = 0;
  let latestSummary: FlightSummary | undefined;

  return withRunScope({ runId, limits, parentSignal }, async (scope) => {
    let status: PersistedCheckpoint['status'] = 'running';

    try {
      checkpointStore.save(checkpointFor(runId, status, 0));
      scope.cache.set('prompt-summary', prompt.slice(0, 80));

      for (let step = 1; step <= limits.maxSteps; step += 1) {
        scope.signal.throwIfAborted();

        const decision = await fakeModelCall({
          step,
          plannedToolSteps,
          neverFinal,
          failAtStep: failModelAtStep,
          signal: scope.signal,
        });

        if (decision.kind === 'final') {
          status = 'completed';
          const checkpoint = checkpointFor(runId, status, step, latestSummary?.cheapestFlightId);
          checkpointStore.save(checkpoint);
          return {
            runId,
            answer: latestSummary
              ? `cheapest is ${latestSummary.cheapestFlightId} at $${latestSummary.cheapestPriceUsd}`
              : decision.text,
            steps: step,
            toolCalls,
            peakCacheEntries,
            retainedRawToolResponses: scope.rawToolResponses.length,
            checkpoint,
          };
        }

        toolCalls += 1;
        if (toolCalls > limits.maxToolCalls) {
          throw new Error(`tool call limit exceeded: ${limits.maxToolCalls}`);
        }

        const span = scope.startTrace(`${decision.toolName}:${toolCalls}`);
        try {
          const raw = await searchFlights(decision.input, {
            signal: scope.signal,
            latencyMs: toolLatencyMs,
            candidateCount,
            responsePaddingBytes,
          });
          scope.rawToolResponses.push(raw);

          const summary = summarizeFlights(raw);
          latestSummary = summary;
          scope.cache.set(`tool:${toolCalls}:summary`, JSON.stringify(summary));
          peakCacheEntries = Math.max(peakCacheEntries, scope.cache.size);

          if (summary.rawBytes <= limits.maxRawToolResponseBytes) {
            scope.cache.set(`tool:${toolCalls}:small-result`, JSON.stringify(summary));
          }

          scope.releaseRawToolResponses();
          checkpointStore.save(
            checkpointFor(runId, 'waiting_for_approval', step, summary.cheapestFlightId),
          );
        } finally {
          span.dispose();
        }
      }

      throw new Error(`step limit exceeded: ${limits.maxSteps}`);
    } catch (err) {
      status = scope.signal.aborted ? 'cancelled' : 'failed';
      checkpointStore.save(
        checkpointFor(
          runId,
          status,
          Math.min(toolCalls, limits.maxSteps),
          latestSummary?.cheapestFlightId,
        ),
      );
      throw err;
    }
  });
}

export function collectSafeMetrics(label = 'after'): DemoMetrics {
  return {
    label,
    completedRuns: checkpointStore
      .values()
      .filter((checkpoint) => checkpoint.status === 'completed')
      .length,
    activeRunRegistryEntries: activeRunRegistry.size,
    heapMb: heapMb(),
    rssMb: rssMb(),
    retainedRawToolResponses: [...activeRunRegistry.values()].reduce(
      (total, scope) => total + scope.rawToolResponses.length,
      0,
    ),
    persistedBytes: checkpointStore.approximateBytes(),
    activeTimers: activeRunTimers.size,
    activeTraceHandles: TraceSpan.active.size,
    cacheEntries: [...activeRunRegistry.values()].reduce(
      (total, scope) => total + scope.cache.size,
      0,
    ),
  };
}

async function runAfterDemo(): Promise<void> {
  resetSafeState();
  const runs = Number(process.env.RUNS ?? 12);

  banner('Demo 1 - working memory after', 'after');
  for (let index = 0; index < runs; index += 1) {
    const result = await runSafeAgent({ runId: `after-${index}` });
    const metrics = collectSafeMetrics();
    process.stdout.write(
      `run ${String(index + 1).padStart(2)}  registry=${String(metrics.activeRunRegistryEntries).padStart(2)}`
        + `  raw=${String(metrics.retainedRawToolResponses).padStart(3)}`
        + `  cache=${String(metrics.cacheEntries).padStart(4)}`
        + `  checkpoint=${String(bytesOf(result.checkpoint)).padStart(4)} bytes`
        + `  answer="${result.answer}"\n`,
    );
  }

  kv({ ...collectSafeMetrics() });
  console.log(
    '\nThe registry returns to zero because working memory is scoped to one run and disposed in finally.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runAfterDemo();
}
