import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateConversation,
  turnsToMessages,
} from '../src/02-conversation-history/conversation';
import {
  buildContextWindow,
  DEFAULT_CONTEXT_CONFIG,
  mandatoryTokenCount,
} from '../src/02-conversation-history/window';

test('full transcript remains stored', () => {
  const store = generateConversation(100);
  const before = store.size;

  buildContextWindow(store);

  assert.equal(store.size, before);
  assert.equal(store.all().length, 100);
});

test('mandatory context is always included in the budget', () => {
  const window = buildContextWindow(generateConversation(100));

  assert.equal(window.mandatoryTokens, mandatoryTokenCount(DEFAULT_CONTEXT_CONFIG));
  assert.ok(window.mandatoryTokens > 0);
  assert.ok(window.promptTokens >= window.mandatoryTokens);
});

test('newest complete turns are selected', () => {
  const window = buildContextWindow(generateConversation(100));
  const selectedIds = window.selectedTurns.map((turn) => turn.id);
  const expectedSuffix = Array.from(
    { length: selectedIds.length },
    (_, index) => 100 - selectedIds.length + index + 1,
  );

  assert.equal(selectedIds.at(-1), 100);
  assert.deepEqual(selectedIds, expectedSuffix);
});

test('selected turns are chronologically ordered', () => {
  const window = buildContextWindow(generateConversation(100));
  const selectedIds = window.selectedTurns.map((turn) => turn.id);
  const sorted = [...selectedIds].sort((a, b) => a - b);

  assert.deepEqual(selectedIds, sorted);
});

test('no partial turn is included', () => {
  const window = buildContextWindow(generateConversation(100));
  const messages = turnsToMessages(window.selectedTurns);
  const counts = new Map<number, number>();

  messages.forEach((message) => {
    assert.equal(typeof message.turnId, 'number');
    counts.set(message.turnId!, (counts.get(message.turnId!) ?? 0) + 1);
  });

  counts.forEach((count) => assert.equal(count, 2));
});

test('final input stays below the token limit', () => {
  const window = buildContextWindow(generateConversation(100));

  assert.equal(window.fits, true);
  assert.ok(window.promptTokens <= DEFAULT_CONTEXT_CONFIG.contextLimit);
});
