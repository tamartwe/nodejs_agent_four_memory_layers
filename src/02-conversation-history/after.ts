import { pathToFileURL } from 'node:url';
import {
  CONTEXT_LIMIT,
  generateConversation,
  printHistoryTable,
  type HistoryMetrics,
} from './conversation';
import {
  buildContextWindow,
  DEFAULT_CONTEXT_CONFIG,
  type ContextWindowResult,
} from './window';
import { banner, kv } from '../lib/report';

export function boundedWindowMetrics(turns: number, label = `after:${turns}`): HistoryMetrics {
  const store = generateConversation(turns);
  const window = buildContextWindow(store, DEFAULT_CONTEXT_CONFIG);
  return {
    label,
    storedTurns: store.size,
    turnsSent: window.selectedTurns.length,
    promptTokens: window.promptTokens,
    summaryTokens: window.summaryTokens,
    excludedTurns: window.excludedTurns.length,
    contextLimit: CONTEXT_LIMIT,
    fits: window.fits,
  };
}

export function afterRows(turnCounts = [1, 5, 10, 25, 50, 75, 100]): HistoryMetrics[] {
  return turnCounts.map((count) => boundedWindowMetrics(count));
}

export function buildAfterWindow(turns = 100): ContextWindowResult {
  return buildContextWindow(generateConversation(turns), DEFAULT_CONTEXT_CONFIG);
}

async function runAfterDemo(): Promise<void> {
  banner('Demo 2 - conversation history after', 'after');
  console.log(
    'Storage keeps the full transcript. The model receives a bounded, token-aware window.\n',
  );
  printHistoryTable(afterRows());

  const window = buildAfterWindow(100);
  kv({
    'full transcript stored': '100 turns',
    'newest selected turn': window.selectedTurns.at(-1)?.id,
    'oldest selected turn': window.selectedTurns[0]?.id,
    'summary preview': window.summary.slice(0, 90),
  });
  console.log(
    '\nThe old turns are still in storage; they are represented in the prompt by a bounded summary.\n',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runAfterDemo();
}
