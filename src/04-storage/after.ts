import {
  admit,
  countContextChars,
  isEligibleForWindowsCurrent,
  KNOWLEDGE,
  line,
  MACOS_QUERY,
  rerank,
  retrieveHybrid,
  simulateStrictAnswer,
  WINDOWS_QUERY,
  type KnowledgeChunk,
} from './knowledge';

const CANDIDATES = 5;
const ADMIT = {
  threshold: 0.7,
  maxChunks: 3,
  contextBudgetChars: 850,
};

interface RemovalCounts {
  linux: number;
  wrongProduct: number;
  stale: number;
  other: number;
}

function decide(query: string): boolean {
  return query.toLowerCase().includes('rotate') || query.toLowerCase().includes('signing key');
}

function narrow(query: string): { eligible: KnowledgeChunk[]; removed: RemovalCounts } {
  const wantsMacos = query.toLowerCase().includes('macos');
  const removed: RemovalCounts = {
    linux: 0,
    wrongProduct: 0,
    stale: 0,
    other: 0,
  };

  const eligible = KNOWLEDGE.filter((chunk) => {
    if (chunk.product !== 'sensor') {
      removed.wrongProduct += 1;
      return false;
    }
    if (wantsMacos) {
      if (chunk.platform !== 'macos') {
        removed.other += 1;
        return false;
      }
      return true;
    }
    if (chunk.platform === 'linux') {
      removed.linux += 1;
      return false;
    }
    if (!isEligibleForWindowsCurrent(chunk)) {
      removed.stale += chunk.version === '4.2' ? 1 : 0;
      removed.other += chunk.version === '4.2' ? 0 : 1;
      return false;
    }
    return true;
  });

  return { eligible, removed };
}

function runQuery(query: string): void {
  console.log('QUERY');
  console.log(query);

  console.log('\n[DECIDE]');
  const needsRetrieval = decide(query);
  console.log(`External knowledge required: ${needsRetrieval ? 'yes' : 'no'}`);
  if (!needsRetrieval) return;

  console.log('\n[NARROW]');
  const { eligible, removed } = narrow(query);
  console.log(`${KNOWLEDGE.length} chunks -> ${eligible.length} eligible chunks`);
  console.log(
    `removed: Linux=${removed.linux}, wrong product=${removed.wrongProduct}, `
      + `stale=${removed.stale}, other=${removed.other}`,
  );

  console.log('\n[RETRIEVE]');
  const candidates = retrieveHybrid(query, eligible, CANDIDATES);
  console.log(`${eligible.length} eligible -> ${candidates.length} candidates`);
  candidates.forEach((chunk, index) => {
    console.log(
      `${index + 1}. ${chunk.title.padEnd(45)}`
        + ` semantic ${chunk.semanticScore.toFixed(2)}`
        + ` keyword ${chunk.keywordScore.toFixed(2)}`,
    );
  });

  console.log('\n[RERANK]');
  const ranked = rerank(query, candidates);
  ranked.forEach((chunk, index) => {
    console.log(`${index + 1}. ${chunk.title.padEnd(45)} ${chunk.rerankScore.toFixed(2)}`);
  });

  console.log('\n[ADMIT]');
  const admitted = admit(ranked, ADMIT);
  if (admitted.length === 0) {
    console.log('0 chunks passed relevance threshold.');
    console.log('No knowledge injected into model context.');
  } else {
    console.log(`${ranked.length} candidates -> ${admitted.length} chunks admitted`);
  }

  console.log('\nCONTEXT SENT TO MODEL');
  console.log(`${admitted.length} chunks`);
  console.log(`${countContextChars(admitted)} characters`);

  console.log('\nSIMULATED ANSWER');
  console.log(simulateStrictAnswer(admitted));
  console.log('\n');
}

line('AFTER — RETRIEVAL PIPELINE');
runQuery(WINDOWS_QUERY);
runQuery(MACOS_QUERY);

console.log('FIX:');
console.log('Retrieve broadly.');
console.log('Admit narrowly.');
console.log('\nThe goal is not to retrieve as much knowledge as possible.');
console.log('The goal is to expose the model to the smallest high-signal');
console.log('set of evidence needed to answer correctly.\n');
