import 'dotenv/config';
import { banner, section, heapLine, colors } from '../panel/dashboard.js';
import { LiveModel, ScriptedModel, type ModelClient } from '../model/client.js';
import { buildTools } from '../tools/index.js';
import { SpillStore } from '../l3/spill.js';
import { runStrawman } from '../agent/loop.js';
import { transcriptTokens } from '../l2/tokens.js';
import type { Message } from '../l2/types.js';
import { investigationScript } from './script.js';

/**
 * ACT 0 — the 15-line agent everyone writes.
 *
 * messages.push() in a loop. No eviction, no lifecycle, no retrieval. It works
 * beautifully for a handful of turns, which is exactly why everyone ships it.
 *
 * Runs against the REAL Claude API by default — a real model deciding real tool calls,
 * with real token/cost numbers coming straight off the response. Deliberately small scale
 * (a handful of turns, a cheap/fast model) so it's a live demo you can run on stage in
 * seconds for cents, not a $40 / 20-minute fake number on a slide. Set MODEL to point it
 * at something else (e.g. `MODEL=claude-opus-5 npm run act0`).
 *
 * Falls back to an offline scripted model ONLY when ANTHROPIC_API_KEY is unset, so the
 * repo still runs without a key — but it says so loudly. Never present that fallback as
 * a real number.
 */
banner('ACT 0', 'The strawman: messages.push() in a loop');

const spill = new SpillStore();
// The strawman never spills a result or hangs a call, so it doesn't get read_result or
// hanging_tool either — those only make sense once L3 (act3/act5) is in the loop, and
// handing them to the model here just invites a confused call into a tool that can't work.
const tools = buildTools({ spill }).subset(['list_issues', 'read_issue', 'search_code', 'read_file', 'run_tests']);

const live = Boolean(process.env.ANTHROPIC_API_KEY);
const modelId = process.env.MODEL ?? 'claude-haiku-4-5';

if (live) {
  console.log(colors.dim(`  live mode: real calls to ${modelId} (override with MODEL=...)\n`));
} else {
  console.log(colors.yellow('  ANTHROPIC_API_KEY is not set.'));
  console.log(colors.yellow('  Falling back to an OFFLINE SCRIPTED model — these numbers are not real.'));
  console.log(colors.yellow('  export ANTHROPIC_API_KEY before showing this on stage.\n'));
}

const system =
  'You are a repo archaeologist investigating a production incident. Use the available tools before answering. Be concise — one or two sentences per turn.';

function makeModel(scriptSteps: number): ModelClient {
  return live ? new LiveModel({ model: modelId }) : new ScriptedModel(investigationScript(scriptSteps));
}

function onTurn(model: ModelClient) {
  return (turn: number, messages: Message[]) => {
    console.log(`    turn ${turn + 1}: ${transcriptTokens(messages)} tokens so far   $${model.costUsd.toFixed(4)}`);
  };
}

section(live ? 'a few real turns' : 'a few scripted turns (rehearsal)');
const firstModel = makeModel(5);
let history: Message[];
{
  const model = firstModel;
  const { messages } = await runStrawman(
    'Investigate why checkout requests are failing. First call list_issues to find candidates, ' +
      'then call read_issue on at least two of the most relevant issue ids. Then give the likely ' +
      'root cause in one sentence.',
    {
      system,
      model,
      tools,
      spill,
      maxSteps: 8,
      onTurn: onTurn(model),
    },
  );
  console.log(
    `\n  messages: ${messages.length}   tokens: ${transcriptTokens(messages)}   cost: $${model.costUsd.toFixed(4)}`,
  );
  console.log(colors.green('  Works perfectly. Ship it.'));
  history = messages;
}

section(live ? 'a few more real turns — reading real files' : 'a few more scripted turns (rehearsal)');
{
  const model = makeModel(11);
  const before = process.memoryUsage();
  const { messages } = await runStrawman(
    'Now go deeper on the same incident: call search_code for the relevant symbol, then call ' +
      'read_file on the two most relevant files it points to. Summarize what the code confirms ' +
      'about the root cause in two or three sentences.',
    {
      system,
      model,
      tools,
      spill,
      maxSteps: 7,
      history,
      onTurn: onTurn(model),
    },
  );
  const after = process.memoryUsage();
  const tokens = transcriptTokens(messages);

  console.log(
    `\n  messages: ${messages.length}   tokens: ${colors.red(String(tokens))}   cost: $${model.costUsd.toFixed(4)}`,
  );
  heapLine('after strawman run');
  console.log(`heap delta: ${((after.heapUsed - before.heapUsed) / 1e6).toFixed(1)} MB`);

  console.log('');
  console.log(colors.red(`  The transcript is now ${tokens.toLocaleString()} tokens.`));
  console.log(colors.red('  Every one of those tokens is re-sent on the NEXT request, at full price.'));
  console.log(colors.dim('  Act 1: what happens when it crosses the window.'));
}
