import type Anthropic from '@anthropic-ai/sdk';

/**
 * Real tools, real work. Two of them deliberately return large payloads —
 * that is the whole point of Layer 3.
 */

export interface SkuInput {
  sku: string;
}

export interface SkuRecord {
  sku: string;
  name: string;
  onHand: number;
  warehouse: string;
}

export interface TelemetryInput {
  deviceId: string;
  rows?: number;
}

export interface TelemetryRow {
  ts: string;
  deviceId: string;
  cpu: string;
  memMb: number;
  netKbps: number;
  firmware: string;
  region: string;
}

export interface TelemetryResult {
  deviceId: string;
  rowCount: number;
  rows: TelemetryRow[];
}

export interface IncidentInput {
  title: string;
  severity: string;
}

export interface IncidentResult {
  id: string;
  title: string;
  severity: string;
}

export type ToolResult = SkuRecord | TelemetryResult | IncidentResult;

const INVENTORY = new Map<string, Omit<SkuRecord, 'sku'>>([
  ['SKU-4471', { name: 'Edge gateway v3', onHand: 42, warehouse: 'TLV-1' }],
  ['SKU-8830', { name: 'Thermal sensor kit', onHand: 7, warehouse: 'HFA-2' }],
  ['SKU-1102', { name: 'LoRa relay board', onHand: 0, warehouse: 'TLV-1' }],
]);

/** Deterministic pseudo-telemetry so payload size is predictable on stage. */
function telemetryRows(deviceId: string, n: number): TelemetryRow[] {
  const rows: TelemetryRow[] = [];
  let seed = [...deviceId].reduce((a, c) => a + c.charCodeAt(0), 0);
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    rows.push({
      ts: new Date(Date.UTC(2026, 6, 1, 0, 0, i)).toISOString(),
      deviceId,
      cpu: Number((seed % 1000) / 1000).toFixed(3),
      memMb: 200 + (seed % 800),
      netKbps: seed % 5000,
      firmware: `3.${seed % 9}.${Math.floor(seed / 8) % 9}`,
      region: ['eu-west-1', 'us-east-1', 'ap-south-1'][seed % 3] as string,
    });
  }
  return rows;
}

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'lookup_sku',
    description: 'Look up a single inventory SKU. Returns a small record.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'e.g. SKU-4471' } },
      required: ['sku'],
    },
  },
  {
    name: 'fetch_device_telemetry',
    description:
      'Fetch raw telemetry rows for a device. WARNING: returns hundreds of KB of JSON.',
    input_schema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string' },
        rows: { type: 'integer', description: 'How many rows to return (default 600)' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'open_incident',
    description: 'Open an incident ticket. Fails if severity is not one of P1..P4.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string' },
      },
      required: ['title', 'severity'],
    },
  },
];

export interface RunToolOptions {
  signal?: AbortSignal;
}

export const HANDLERS = {
  async lookup_sku({ sku }: SkuInput): Promise<SkuRecord> {
    const hit = INVENTORY.get(sku);
    if (!hit) throw new Error(`unknown sku ${sku}`);
    return { sku, ...hit };
  },

  async fetch_device_telemetry({ deviceId, rows = 600 }: TelemetryInput): Promise<TelemetryResult> {
    return { deviceId, rowCount: rows, rows: telemetryRows(deviceId, rows) };
  },

  async open_incident({ title, severity }: IncidentInput): Promise<IncidentResult> {
    if (!/^P[1-4]$/.test(severity)) {
      // Deliberate failure path. This is where pending-call maps leak.
      throw new Error(`invalid severity "${severity}", expected P1..P4`);
    }
    return { id: `INC-${Math.floor(Math.random() * 9000 + 1000)}`, title, severity };
  },
} as const;

export type ToolName = keyof typeof HANDLERS;

export async function runTool(
  name: string,
  input: unknown,
  { signal }: RunToolOptions = {},
): Promise<ToolResult> {
  signal?.throwIfAborted();
  switch (name as ToolName) {
    case 'lookup_sku':
      return HANDLERS.lookup_sku(input as SkuInput);
    case 'fetch_device_telemetry':
      return HANDLERS.fetch_device_telemetry(input as TelemetryInput);
    case 'open_incident':
      return HANDLERS.open_incident(input as IncidentInput);
    default:
      throw new Error(`no such tool: ${name}`);
  }
}
