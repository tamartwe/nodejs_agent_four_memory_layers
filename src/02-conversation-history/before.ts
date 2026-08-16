import { pathToFileURL } from 'node:url';
import {
  CONTEXT_LIMIT,
  CURRENT_INPUT,
  estimateMessageTokens,
  estimateTextTokens,
  generateConversation,
  printHistoryTable,
  RESPONSE_RESERVE_TOKENS,
  SAFETY_MARGIN_TOKENS,
  SYSTEM_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  turnsToMessages,
  type ConversationStore,
  type HistoryMetrics,
} from './conversation';
import { banner } from '../lib/report';

export function loadEverythingMetrics(store: ConversationStore, label = 'before'): HistoryMetrics {
  const allTurns = store.all();
  const historyTokens = estimateMessageTokens(turnsToMessages(allTurns));
  const promptTokens = estimateTextTokens(SYSTEM_INSTRUCTIONS)
    + estimateTextTokens(TOOL_DEFINITIONS)
    + estimateTextTokens(CURRENT_INPUT)
    + RESPONSE_RESERVE_TOKENS
    + SAFETY_MARGIN_TOKENS
    + historyTokens;

  return {
    label,
    storedTurns: store.size,
    turnsSent: allTurns.length,
    promptTokens,
    summaryTokens: 0,
    excludedTurns: 0,
    contextLimit: CONTEXT_LIMIT,
    fits: promptTokens <= CONTEXT_LIMIT,
  };
}

export function beforeRows(turnCounts = [1, 5, 10, 25, 50, 75, 100]): HistoryMetrics[] {
  return turnCounts.map((count) => loadEverythingMetrics(generateConversation(count), `before:${count}`));
}

async function runBeforeDemo(): Promise<void> {
  banner('Demo 2 - conversation history before', 'before');
  console.log(
    'Storage is complete, but the prompt builder sends every stored turn on every request.\n',
  );
  printHistoryTable(beforeRows());
  console.log(
    '\nThe storage choice is fine. The failure is loading all history into the model context.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runBeforeDemo();
}
