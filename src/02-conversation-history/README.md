# Demo 2 - Conversation History

## Scenario

Conversation history is the full transcript of a user-agent conversation. The storage layer should keep it for audit, replay, and future summarization.

The model context is different. It should receive only what fits: mandatory instructions, tool descriptions, the current user input, a response reserve, a safety margin, a bounded summary, and the newest complete turns.

This demo is deterministic. It uses no model, no API key, and no network.

## Commands

```bash
npm run demo:2:before
npm run demo:2:after
npm run demo:2:compare
npm test
npm run typecheck
```

## Before: Load Everything

The before implementation stores a complete transcript and sends every stored turn:

```ts
const allTurns = store.all();
const prompt = turnsToMessages(allTurns);
```

This fails because prompt tokens grow with every turn. With the deliberately small context limit, the prompt eventually overflows.

## After: Bounded Context Window

The after implementation keeps storage unchanged, but builds a token-aware prompt:

1. Reserve tokens for system instructions, tools, current input, response output, and safety margin.
2. Add a bounded deterministic summary of older history.
3. Walk backward from the newest complete turn.
4. Add complete turns while they fit.
5. Stop before the first turn that would exceed the budget.
6. Restore selected turns to chronological order.
7. Keep the complete transcript unchanged in storage.
8. Update the summary when older turns leave the window.

Slide-sized snippet:

```ts
for (let i = turns.length - 1; i >= 0; i -= 1) {
  const next = selectedTokens + estimateTurnTokens(turns[i]);
  if (mandatory + summaryTokens + next > contextLimit) break;
  selectedNewestFirst.push(turns[i]);
}

const selectedTurns = selectedNewestFirst.reverse();
```

## Presentation Explanation

The point is not "delete old conversation." The point is:

> Store everything. Send only the bounded window.

Use `npm run demo:2:compare` as the live punchline. The before rows eventually show `fits=NO`; the after rows keep `fits=yes` even with 100 stored turns.

## Expected Output

The table includes:

- Stored turns
- Turns sent to the model
- Prompt tokens
- Summary tokens
- Excluded turns
- Context limit
- Whether the request fits

Before: stored turns and turns sent are the same.

After: stored turns keep growing, but turns sent stays bounded.
