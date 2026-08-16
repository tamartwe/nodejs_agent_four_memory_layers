import type Anthropic from '@anthropic-ai/sdk';
import {
  CURRENT_INPUT,
  estimateMessageTokens,
  estimateTextTokens,
  estimateTurnTokens,
  RESPONSE_RESERVE_TOKENS,
  SAFETY_MARGIN_TOKENS,
  SUMMARY_BUDGET_TOKENS,
  SYSTEM_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  turnsToMessages,
  type ConversationMessage,
  type ConversationStore,
  type ConversationTurn,
} from './conversation';

export interface ContextWindowConfig {
  contextLimit: number;
  responseReserveTokens: number;
  safetyMarginTokens: number;
  summaryBudgetTokens: number;
  systemInstructions: string;
  toolDefinitions: string;
  currentInput: string;
}

export const DEFAULT_CONTEXT_CONFIG: ContextWindowConfig = {
  contextLimit: 1_450,
  responseReserveTokens: RESPONSE_RESERVE_TOKENS,
  safetyMarginTokens: SAFETY_MARGIN_TOKENS,
  summaryBudgetTokens: SUMMARY_BUDGET_TOKENS,
  systemInstructions: SYSTEM_INSTRUCTIONS,
  toolDefinitions: TOOL_DEFINITIONS,
  currentInput: CURRENT_INPUT,
};

export interface ContextWindowResult {
  storedTurns: number;
  selectedTurns: ConversationTurn[];
  excludedTurns: ConversationTurn[];
  messages: ConversationMessage[];
  summary: string;
  promptTokens: number;
  summaryTokens: number;
  mandatoryTokens: number;
  remainingHistoryBudget: number;
  fits: boolean;
}

export function mandatoryTokenCount(config: ContextWindowConfig): number {
  return estimateTextTokens(config.systemInstructions)
    + estimateTextTokens(config.toolDefinitions)
    + estimateTextTokens(config.currentInput)
    + config.responseReserveTokens
    + config.safetyMarginTokens;
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const selected: string[] = [];
  for (const word of words) {
    const candidate = [...selected, word].join(' ');
    if (estimateTextTokens(candidate) > maxTokens) break;
    selected.push(word);
  }
  return selected.join(' ');
}

export function summarizeTurns(turns: ConversationTurn[], maxTokens: number): string {
  if (turns.length === 0 || maxTokens <= 0) return '';

  const facts = turns.flatMap((turn) => {
    const important = turn.user.match(/CR-\d+|rollback window is \d+ minutes/i)?.[0];
    if (important) {
      return [`T${turn.id}: ${important}.`];
    }
    if (turn.id % 10 === 0) {
      return [`T${turn.id}: rollout batch ${String(turn.id).padStart(3, '0')} reviewed.`];
    }
    return [];
  });

  const fallback = `Earlier conversation covered turns 1-${turns.at(-1)?.id ?? 0}; `
    + 'keep staged rollout, firmware 3.4.2, telemetry lag, and rollback ownership.';
  return truncateToTokenBudget((facts.length ? facts : [fallback]).join(' '), maxTokens);
}

export function buildContextWindow(
  store: ConversationStore,
  config: ContextWindowConfig = DEFAULT_CONTEXT_CONFIG,
): ContextWindowResult {
  const allTurns = store.all();
  const mandatoryTokens = mandatoryTokenCount(config);
  const maxSummaryTokens = Math.min(
    config.summaryBudgetTokens,
    Math.max(0, config.contextLimit - mandatoryTokens),
  );

  let selectedTokens = 0;
  const selectedNewestFirst: ConversationTurn[] = [];

  for (let index = allTurns.length - 1; index >= 0; index -= 1) {
    const turn = allTurns[index]!;
    const nextTokens = selectedTokens + estimateTurnTokens(turn);
    const olderTurns = allTurns.slice(0, index);
    const summary = summarizeTurns(olderTurns, maxSummaryTokens);
    const summaryTokens = summary ? estimateTextTokens(summary) : 0;
    const total = mandatoryTokens + summaryTokens + nextTokens;

    if (total > config.contextLimit) break;

    selectedNewestFirst.push(turn);
    selectedTokens = nextTokens;
  }

  const selectedTurns = selectedNewestFirst.reverse();
  const firstSelectedId = selectedTurns[0]?.id ?? allTurns.length + 1;
  const excludedTurns = allTurns.filter((turn) => turn.id < firstSelectedId);
  const summary = summarizeTurns(excludedTurns, maxSummaryTokens);
  const summaryTokens = summary ? estimateTextTokens(summary) : 0;
  const messages = [
    ...(summary ? [{ role: 'system' as const, content: `Earlier history summary: ${summary}` }] : []),
    ...turnsToMessages(selectedTurns),
    { role: 'user' as const, content: config.currentInput },
  ];
  const promptTokens = mandatoryTokens
    + summaryTokens
    + estimateMessageTokens(turnsToMessages(selectedTurns));

  return {
    storedTurns: allTurns.length,
    selectedTurns,
    excludedTurns,
    messages,
    summary,
    promptTokens,
    summaryTokens,
    mandatoryTokens,
    remainingHistoryBudget: Math.max(0, config.contextLimit - mandatoryTokens - summaryTokens),
    fits: promptTokens <= config.contextLimit,
  };
}

export function estimateTokens(messages: Anthropic.MessageParam[] | ConversationMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export interface ConversationWindowOptions {
  budgetTokens?: number;
  compactToTokens?: number;
  keepRecentTurns?: number;
  pinFirstTurns?: number;
  summarise?: (dropped: Anthropic.MessageParam[]) => Promise<string>;
}

export class ConversationWindow {
  budgetTokens: number;

  compactToTokens: number;

  keepRecentTurns: number;

  pinFirstTurns: number;

  summariseFn: (dropped: Anthropic.MessageParam[]) => Promise<string>;

  messages: Anthropic.MessageParam[] = [];

  summary: string | null = null;

  compactions = 0;

  evicted = 0;

  constructor({
    budgetTokens = 4_000,
    compactToTokens = 2_000,
    keepRecentTurns = 6,
    pinFirstTurns = 1,
    summarise,
  }: ConversationWindowOptions = {}) {
    this.budgetTokens = budgetTokens;
    this.compactToTokens = compactToTokens;
    this.keepRecentTurns = keepRecentTurns;
    this.pinFirstTurns = pinFirstTurns;
    this.summariseFn = summarise ?? ((dropped) => Promise.resolve(`Compacted ${dropped.length} messages.`));
  }

  push(msg: Anthropic.MessageParam): void {
    this.messages.push(msg);
  }

  async maybeCompact(): Promise<boolean> {
    if (estimateTokens(this.messages) <= this.budgetTokens) return false;

    const keepMessages = this.keepRecentTurns * 2;
    const pinned = this.messages.slice(0, this.pinFirstTurns * 2);
    const keepFrom = Math.max(pinned.length, this.messages.length - keepMessages);
    const dropped = this.messages.slice(pinned.length, keepFrom);
    if (dropped.length === 0) return false;

    this.summary = await this.summariseFn(dropped);
    this.messages = [...pinned, ...this.messages.slice(keepFrom)];
    this.compactions += 1;
    this.evicted += dropped.length;
    return true;
  }

  build(systemPrompt: string): {
    system: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: systemPrompt }];
    if (this.summary) {
      system.push({ type: 'text', text: `Earlier in this conversation:\n${this.summary}` });
    }
    return { system, messages: this.messages };
  }
}
