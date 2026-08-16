/**
 * Multi-step workflows that force several tool calls each. Every one of them
 * includes at least one call that will fail — open_incident rejects any
 * severity outside P1..P4, and the model will usually try "high" or "critical"
 * at least once before it reads the error and corrects.
 *
 * That failure is the point. It is the path where pendingCalls leaks.
 */
export const WORKFLOW: string[] = [
  'Check SKU-8830 and SKU-1102. For anything with zero stock, open an incident with severity "critical". '
    + 'Then pull 600 telemetry rows for device edge-a1 and tell me which firmware version dominates.',

  'Pull 600 telemetry rows for edge-b2 and edge-c3. Compare their region distribution, '
    + 'then look up SKU-4471 and open a high severity incident if on-hand is under 50.',

  'Look up all three SKUs (SKU-4471, SKU-8830, SKU-1102). Pull 600 telemetry rows for edge-d4. '
    + 'Open an incident titled "fleet audit" with severity "urgent" summarising what you found.',
];
