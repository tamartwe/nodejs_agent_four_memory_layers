export type WorkflowStatus = 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';

export interface AgentLimits {
  maxSteps: number;
  maxExecutionMs: number;
  maxToolCalls: number;
  maxCacheEntries: number;
  maxRawToolResponseBytes: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 5,
  maxExecutionMs: 1_000,
  maxToolCalls: 4,
  maxCacheEntries: 8,
  maxRawToolResponseBytes: 12_000,
};

export interface FlightCandidate {
  id: string;
  carrier: string;
  priceUsd: number;
  departAt: string;
  arriveAt: string;
  baggagePolicy: string;
  rawFareRules: string;
}

export interface RawFlightSearchResponse {
  requestId: string;
  origin: string;
  destination: string;
  generatedAt: string;
  candidates: FlightCandidate[];
  diagnostics: {
    shard: string;
    tracePayload: string;
  };
}

export interface FlightSummary {
  cheapestFlightId: string;
  cheapestPriceUsd: number;
  candidateCount: number;
  rawBytes: number;
}

export interface PersistedCheckpoint {
  runId: string;
  status: WorkflowStatus;
  currentStep: number;
  selectedFlightId?: string;
  idempotencyKey: string;
  expiresAt: string;
}

export interface DemoMetrics {
  label: string;
  completedRuns: number;
  activeRunRegistryEntries: number;
  heapMb: number;
  rssMb: number;
  retainedRawToolResponses: number;
  persistedBytes: number;
  activeTimers: number;
  activeTraceHandles: number;
  cacheEntries: number;
}

export interface AgentResult {
  runId: string;
  answer: string;
  steps: number;
  toolCalls: number;
  peakCacheEntries: number;
  retainedRawToolResponses: number;
  checkpoint: PersistedCheckpoint;
}
