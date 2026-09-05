import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admit,
  isEligibleForWindowsCurrent,
  KNOWLEDGE,
  MACOS_QUERY,
  naiveSearch,
  rerank,
  retrieveHybrid,
  WINDOWS_QUERY,
} from '../src/04-storage/knowledge';

test('before retrieves one correct chunk plus plausible distractors', () => {
  const hits = naiveSearch(WINDOWS_QUERY, 10);

  assert.equal(hits.length, 10);
  assert.equal(hits.filter((hit) => hit.id === 'KB-WIN-ROTATE-47').length, 1);
  assert.ok(hits.some((hit) => hit.id === 'KB-API-KEY-ROTATE'));
  assert.ok(hits.some((hit) => hit.id === 'KB-LINUX-CERT-ROTATE'));
  assert.ok(hits.some((hit) => hit.id === 'KB-WIN-ROTATE-42'));
});

test('after narrows to current Windows sensor docs', () => {
  const eligible = KNOWLEDGE.filter(isEligibleForWindowsCurrent);

  assert.ok(eligible.length > 0);
  assert.equal(eligible.every((chunk) => chunk.product === 'sensor'), true);
  assert.equal(eligible.every((chunk) => chunk.platform === 'windows'), true);
  assert.equal(eligible.every((chunk) => chunk.version === '4.7'), true);
});

test('after admits only high-signal Windows evidence', () => {
  const eligible = KNOWLEDGE.filter(isEligibleForWindowsCurrent);
  const candidates = retrieveHybrid(WINDOWS_QUERY, eligible, 5);
  const admitted = admit(rerank(WINDOWS_QUERY, candidates), {
    threshold: 0.7,
    maxChunks: 3,
    contextBudgetChars: 850,
  });

  assert.ok(admitted.some((chunk) => chunk.id === 'KB-WIN-ROTATE-47'));
  assert.equal(admitted.some((chunk) => chunk.id === 'KB-API-KEY-ROTATE'), false);
  assert.equal(admitted.some((chunk) => chunk.platform === 'linux'), false);
});

test('macOS query admits zero chunks when no macOS docs exist', () => {
  const candidates = retrieveHybrid(MACOS_QUERY, [], 5);
  const admitted = admit(rerank(MACOS_QUERY, candidates), {
    threshold: 0.7,
    maxChunks: 3,
    contextBudgetChars: 850,
  });

  assert.equal(admitted.length, 0);
});
