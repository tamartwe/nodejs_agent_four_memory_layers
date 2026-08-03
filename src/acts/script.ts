import type { ScriptStep } from '../model/client.js';

/**
 * A scripted 40-turn session. Deterministic so every run on stage is identical and the
 * act-to-act comparisons are apples to apples.
 */
export function investigationScript(steps = 20, opts: { includeBigFile?: boolean } = {}): ScriptStep[] {
  const script: ScriptStep[] = [];
  const topics = ['connection', 'timeout', 'retry', 'memory', 'cache', 'deploy'];

  for (let i = 0; i < steps; i++) {
    if (opts.includeBigFile && i === 6) {
      script.push({ toolUses: [{ name: 'read_file', input: { path: 'dist/bundle.big.js' } }] });
      continue;
    }
    if (i % 4 === 0) {
      script.push({ toolUses: [{ name: 'list_issues', input: { topic: topics[i % topics.length], limit: 8 } }] });
    } else if (i % 4 === 1) {
      script.push({ toolUses: [{ name: 'read_issue', input: { id: `ENG-${4400 + i}` } }] });
    } else if (i % 4 === 2) {
      // Parallel tool calls in one assistant turn: all N results must come back.
      script.push({
        toolUses: [
          { name: 'search_code', input: { query: topics[i % topics.length] } },
          { name: 'read_file', input: { path: `src/module-${i}.ts` } },
        ],
      });
    } else {
      script.push({ toolUses: [{ name: 'run_tests', input: { pattern: topics[i % topics.length] } }] });
    }
  }

  script.push({ text: 'Investigation complete. The ECONNRESET originates in socket reuse by the keep-alive agent.' });
  return script;
}
