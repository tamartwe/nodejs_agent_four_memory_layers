import { banner, section, heapLine, colors } from '../panel/dashboard.js';
import { ScriptedModel } from '../model/client.js';
import { buildTools } from '../tools/index.js';
import { SpillStore } from '../l3/spill.js';
import { runStrawman } from '../agent/loop.js';
import { transcriptTokens } from '../l2/tokens.js';
import { investigationScript } from './script.js';

/**
 * ACT 0 — the 15-line agent everyone writes.
 *
 * messages.push() in a loop. No eviction, no lifecycle, no retrieval. It works
 * beautifully for six turns, which is exactly why everyone ships it.
 */
banner('ACT 0', 'The strawman: messages.push() in a loop');

const spill = new SpillStore();
const tools = buildTools({ spill });

section('6 turns');
{
  const model = new ScriptedModel(investigationScript(5));
  const { messages } = await runStrawman('Why do checkout requests fail?', {
    system: 'You are a repo archaeologist.',
    model,
    tools,
    spill,
    maxSteps: 8,
  });
  console.log(`messages: ${messages.length}   tokens: ${transcriptTokens(messages)}   cost: $${model.costUsd.toFixed(4)}`);
  console.log(colors.green('  Works perfectly. Ship it.'));
}

section('20 turns, one of which reads a large file');
{
  const model = new ScriptedModel(investigationScript(20, { includeBigFile: true }));
  const before = process.memoryUsage();
  const { messages } = await runStrawman('Why do checkout requests fail?', {
    system: 'You are a repo archaeologist.',
    model,
    tools,
    spill,
    maxSteps: 24,
  });
  const after = process.memoryUsage();
  const tokens = transcriptTokens(messages);

  console.log(`messages: ${messages.length}   tokens: ${colors.red(String(tokens))}   cost: $${model.costUsd.toFixed(4)}`);
  heapLine('after strawman run');
  console.log(`heap delta: ${((after.heapUsed - before.heapUsed) / 1e6).toFixed(1)} MB`);

  console.log('');
  console.log(colors.red(`  The transcript is now ${tokens.toLocaleString()} tokens.`));
  console.log(colors.red('  Every one of those tokens is re-sent on the NEXT request, at full price.'));
  console.log(colors.dim('  Act 1: what happens when it crosses the window.'));
}
