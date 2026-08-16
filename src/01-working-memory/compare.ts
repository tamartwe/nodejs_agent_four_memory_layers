import { resetToolInstrumentation } from './fake-tools';
import {
  collectUnsafeMetrics,
  resetUnsafeState,
  runUnsafeAgent,
} from './before';
import {
  collectSafeMetrics,
  runSafeAgent,
} from './after';
import { printMetricsTable } from './memory-metrics';
import { resetSafeState } from './workingMemory';
import { banner } from '../lib/report';

const RUNS = Number(process.env.RUNS ?? 20);

banner('Demo 1 - before/after comparison', null);
console.log(`Running ${RUNS} deterministic simulated agent executions per implementation.\n`);

resetToolInstrumentation();
resetUnsafeState();
for (let index = 0; index < RUNS; index += 1) {
  await runUnsafeAgent({ runId: `compare-before-${index}` });
}
const before = collectUnsafeMetrics('before');

resetToolInstrumentation();
resetSafeState();
for (let index = 0; index < RUNS; index += 1) {
  await runSafeAgent({ runId: `compare-after-${index}` });
}
const after = collectSafeMetrics('after');

printMetricsTable([before, after]);

console.log(
  '\nMemory numbers vary with V8 garbage collection. The deterministic signal is the reference graph:'
    + '\n  before: completed runs, raw responses, timers, traces, and full persisted snapshots remain reachable'
    + '\n  after: the active registry, raw responses, timers, traces, and caches return to zero\n',
);
