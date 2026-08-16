export interface ConversationTurn {
  id: number;
  user: string;
  assistant: string;
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  turnId?: number;
}

export const SYSTEM_INSTRUCTIONS = [
  'You are a support engineer assistant for an industrial IoT rollout.',
  'Preserve IDs, rollback windows, limits, and region-specific constraints.',
].join(' ');

export const TOOL_DEFINITIONS = [
  'tools:',
  '- searchTelemetry(region, metric)',
  '- openChangeRequest(id)',
  '- draftRollbackPlan(changeRequestId)',
].join('\n');

export const CURRENT_INPUT = 'Before we finish, produce the final go/no-go checklist and cite the change request ID.';

export const CONTEXT_LIMIT = 1_450;
export const RESPONSE_RESERVE_TOKENS = 260;
export const SAFETY_MARGIN_TOKENS = 120;
export const SUMMARY_BUDGET_TOKENS = 180;

export class ConversationStore {
  private readonly turns: ConversationTurn[] = [];

  add(turn: ConversationTurn): void {
    this.turns.push(turn);
  }

  all(): ConversationTurn[] {
    return [...this.turns];
  }

  latest(count: number): ConversationTurn[] {
    return this.turns.slice(Math.max(0, this.turns.length - count));
  }

  get size(): number {
    return this.turns.length;
  }
}

const REGION_BY_TURN = ['eu-west-1', 'us-east-1', 'ap-south-1'] as const;

function userTurnText(turn: number): string {
  if (turn === 3) {
    return 'Important: change request CR-88214 owns this rollout. Rollback window is 40 minutes.';
  }

  const region = REGION_BY_TURN[turn % REGION_BY_TURN.length];
  return [
    `Turn ${turn}: review rollout batch ${String(turn).padStart(3, '0')} for ${region}.`,
    `We saw ${60 + (turn % 30)} delayed telemetry events and ${3 + (turn % 8)} devices needing retry.`,
    'Keep the recommendation tied to firmware 3.4.2, staged promotion, and on-call handoff notes.',
  ].join(' ');
}

function assistantTurnText(turn: number): string {
  const region = REGION_BY_TURN[turn % REGION_BY_TURN.length];
  return [
    `For batch ${String(turn).padStart(3, '0')}, keep ${region} behind the health gate.`,
    `Record retry count ${3 + (turn % 8)}, promote only after telemetry lag stays below 90 seconds,`,
    'and keep the rollback captain in the go/no-go channel.',
  ].join(' ');
}

export function generateConversation(turns = 100): ConversationStore {
  const store = new ConversationStore();
  for (let index = 1; index <= turns; index += 1) {
    store.add({
      id: index,
      user: userTurnText(index),
      assistant: assistantTurnText(index),
    });
  }
  return store;
}

export function turnToMessages(turn: ConversationTurn): [ConversationMessage, ConversationMessage] {
  return [
    { role: 'user', content: turn.user, turnId: turn.id },
    { role: 'assistant', content: turn.assistant, turnId: turn.id },
  ];
}

export function turnsToMessages(turns: ConversationTurn[]): ConversationMessage[] {
  return turns.flatMap(turnToMessages);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: ConversationMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTextTokens(`${message.role}: ${message.content}`),
    0,
  );
}

export function estimateTurnTokens(turn: ConversationTurn): number {
  return estimateMessageTokens(turnToMessages(turn));
}

export interface HistoryMetrics {
  label: string;
  storedTurns: number;
  turnsSent: number;
  promptTokens: number;
  summaryTokens: number;
  excludedTurns: number;
  contextLimit: number;
  fits: boolean;
}

export function printHistoryTable(rows: HistoryMetrics[]): void {
  const headers = [
    'demo',
    'stored turns',
    'turns sent',
    'prompt tokens',
    'summary tokens',
    'excluded turns',
    'context limit',
    'fits',
  ];
  const body = rows.map((row) => [
    row.label,
    String(row.storedTurns),
    String(row.turnsSent),
    String(row.promptTokens),
    String(row.summaryTokens),
    String(row.excludedTurns),
    String(row.contextLimit),
    row.fits ? 'yes' : 'NO',
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...body.map((line) => line[index]!.length),
  ));
  const printRow = (cells: string[]): void => {
    console.log(cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  '));
  };

  printRow(headers);
  printRow(widths.map((width) => '-'.repeat(width)));
  body.forEach(printRow);
}
