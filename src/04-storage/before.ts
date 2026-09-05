import {
  countContextChars,
  line,
  naiveSearch,
  simulateNaiveAnswer,
  WINDOWS_QUERY,
} from './knowledge';

const TOP_K = 10;

line('BEFORE — NAIVE RETRIEVAL');

console.log('QUERY');
console.log(WINDOWS_QUERY);

const chunks = naiveSearch(WINDOWS_QUERY, TOP_K);

console.log('\nTOP 10 RETRIEVAL\n');
chunks.forEach((chunk, index) => {
  console.log(
    `${String(index + 1).padStart(2)}. ${chunk.title.padEnd(45)}`
      + ` score ${chunk.semanticScore.toFixed(2)}   ${chunk.note}`,
  );
});

const relevant = chunks.filter((chunk) => chunk.id === 'KB-WIN-ROTATE-47').length;
const distractors = chunks.length - relevant;

console.log('\nCONTEXT SENT TO MODEL');
console.log(`${chunks.length} chunks`);
console.log(`${countContextChars(chunks)} characters`);
console.log(`${relevant} relevant chunk + ${distractors} plausible distractors`);

console.log('\nSIMULATED ANSWER');
console.log(simulateNaiveAnswer(chunks));

console.log('\nPROBLEM:');
console.log('We optimized for similarity.');
console.log('We sent everything into context.');
console.log('\nSimilarity != relevance.');
console.log('topK = 10 means the 10 closest results, not 10 correct results.\n');
