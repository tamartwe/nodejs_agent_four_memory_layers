import type { RawFlightSearchResponse } from './types';

export class AbortError extends Error {
  constructor(message = 'operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export interface ToolInstrumentation {
  signalsSeen: number;
  abortedOperations: number;
  completedOperations: number;
  activeOperations: number;
}

export const toolInstrumentation: ToolInstrumentation = {
  signalsSeen: 0,
  abortedOperations: 0,
  completedOperations: 0,
  activeOperations: 0,
};

export function resetToolInstrumentation(): void {
  toolInstrumentation.signalsSeen = 0;
  toolInstrumentation.abortedOperations = 0;
  toolInstrumentation.completedOperations = 0;
  toolInstrumentation.activeOperations = 0;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new AbortError(String(signal.reason ?? 'operation aborted'));
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal!));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FakeModelOptions {
  step: number;
  plannedToolSteps: number;
  neverFinal?: boolean;
  failAtStep?: number;
  signal?: AbortSignal;
  delayMs?: number;
}

export type FakeModelDecision =
  | {
    kind: 'tool_call';
    toolName: 'searchFlights';
    input: {
      origin: string;
      destination: string;
    };
  }
  | {
    kind: 'final';
    text: string;
  };

export async function fakeModelCall({
  step,
  plannedToolSteps,
  neverFinal = false,
  failAtStep,
  signal,
  delayMs = 3,
}: FakeModelOptions): Promise<FakeModelDecision> {
  await abortableDelay(delayMs, signal);
  signal?.throwIfAborted();

  if (failAtStep === step) {
    throw new Error(`simulated model failure at step ${step}`);
  }

  if (neverFinal || step <= plannedToolSteps) {
    return {
      kind: 'tool_call',
      toolName: 'searchFlights',
      input: { origin: 'TLV', destination: 'BER' },
    };
  }

  return { kind: 'final', text: 'cheapest is F-17 at $460' };
}

export interface SearchFlightsOptions {
  signal?: AbortSignal;
  latencyMs?: number;
  candidateCount?: number;
  responsePaddingBytes?: number;
}

export async function searchFlights(
  input: { origin: string; destination: string },
  {
    signal,
    latencyMs = 4,
    candidateCount = 80,
    responsePaddingBytes = 192,
  }: SearchFlightsOptions = {},
): Promise<RawFlightSearchResponse> {
  toolInstrumentation.activeOperations += 1;
  if (signal) toolInstrumentation.signalsSeen += 1;

  try {
    await abortableDelay(latencyMs, signal);
    signal?.throwIfAborted();

    const candidates = Array.from({ length: candidateCount }, (_, index) => ({
      id: index === 0 ? 'F-17' : `F-${index + 20}`,
      carrier: index % 2 === 0 ? 'Demo Air' : 'Memory Jet',
      priceUsd: index === 0 ? 460 : 480 + index,
      departAt: `2026-09-15T${String(8 + (index % 10)).padStart(2, '0')}:20:00+03:00`,
      arriveAt: `2026-09-15T${String(11 + (index % 10)).padStart(2, '0')}:45:00+02:00`,
      baggagePolicy: `policy-${index}-${'bag'.repeat(12)}`,
      rawFareRules: `${input.origin}-${input.destination}-${index}-${'fare-rule'.repeat(responsePaddingBytes / 9)}`,
    }));

    toolInstrumentation.completedOperations += 1;
    return {
      requestId: `${input.origin}-${input.destination}-${Date.now()}-${Math.random()}`,
      origin: input.origin,
      destination: input.destination,
      generatedAt: new Date().toISOString(),
      candidates,
      diagnostics: {
        shard: `search-shard-${candidateCount % 7}`,
        tracePayload: 'trace-'.repeat(responsePaddingBytes),
      },
    };
  } catch (err) {
    if (signal?.aborted || err instanceof AbortError || (err as Error).name === 'AbortError') {
      toolInstrumentation.abortedOperations += 1;
    }
    throw err;
  } finally {
    toolInstrumentation.activeOperations -= 1;
  }
}
