/**
 * DEMO 0 - a tool loop works before memory exists.
 *
 * This is the smallest useful agent loop in the deck:
 * prompt -> decide -> call -> observe -> answer.
 *
 * Run:
 *   npm run demo
 *   npm run demo:0
 */
import type Anthropic from '@anthropic-ai/sdk';
import { callModel, MODEL, UsageMeter } from '../lib/client';
import { banner, kv } from '../lib/report';

interface SearchFlightsInput {
  origin: string;
  destination: string;
}

interface Flight {
  id: string;
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  priceUsd: number;
  carrier: string;
}

interface FlightSearchResult {
  flights: Flight[];
}

const SYSTEM = [
  'You are a travel booking agent.',
  'Use tools before asserting flight facts.',
  'When you have search results, answer with exactly: cheapest is <flight id> at $<price>.',
].join(' ');

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'searchFlights',
    description: 'Search available flights between two airports.',
    input_schema: {
      type: 'object',
      properties: {
        origin: {
          type: 'string',
          description: 'Origin airport code, for example TLV.',
        },
        destination: {
          type: 'string',
          description: 'Destination airport code, for example BER.',
        },
      },
      required: ['origin', 'destination'],
    },
  },
];

function parseSearchFlightsInput(input: unknown): SearchFlightsInput {
  if (
    typeof input === 'object'
    && input !== null
    && 'origin' in input
    && 'destination' in input
    && typeof input.origin === 'string'
    && typeof input.destination === 'string'
  ) {
    return {
      origin: input.origin.toUpperCase(),
      destination: input.destination.toUpperCase(),
    };
  }

  throw new Error(`invalid searchFlights input: ${JSON.stringify(input)}`);
}

function searchFlights(input: SearchFlightsInput): FlightSearchResult {
  return {
    flights: [
      {
        id: 'F-17',
        origin: input.origin,
        destination: input.destination,
        departAt: '2026-09-15T08:20:00+03:00',
        arriveAt: '2026-09-15T11:45:00+02:00',
        priceUsd: 460,
        carrier: 'Demo Air',
      },
      {
        id: 'F-42',
        origin: input.origin,
        destination: input.destination,
        departAt: '2026-09-15T13:10:00+03:00',
        arriveAt: '2026-09-15T16:30:00+02:00',
        priceUsd: 515,
        carrier: 'Memory Jet',
      },
    ],
  };
}

function runTool(name: string, input: unknown): string {
  if (name !== 'searchFlights') {
    throw new Error(`unknown tool: ${name}`);
  }

  const result = searchFlights(parseSearchFlightsInput(input));
  console.log(`step 1: tool  -> searchFlights (${result.flights.length} results)`);
  return JSON.stringify(result);
}

async function main(): Promise<void> {
  const meter = new UsageMeter('demo-0-tool-loop');
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: 'Find the cheapest flight from TLV to BER.',
    },
  ];

  banner('Demo 0 - a tool loop works before memory exists', null);

  const firstResponse = await callModel(meter, {
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM,
    tools: TOOLS,
    tool_choice: { type: 'tool', name: 'searchFlights' },
    messages,
  });

  messages.push({ role: 'assistant', content: firstResponse.content });

  const toolUses = firstResponse.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (toolUses.length === 0) {
    throw new Error('model did not request the searchFlights tool');
  }

  console.log('step 1: model -> tool_call');

  const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((toolUse) => {
    try {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: runTool(toolUse.name, toolUse.input),
      };
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        is_error: true,
        content: (err as Error).message,
      };
    }
  });

  messages.push({ role: 'user', content: toolResults });

  const finalResponse = await callModel(meter, {
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM,
    messages,
  });

  const finalAnswer = finalResponse.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  )?.text.trim() ?? '';

  console.log('step 2: model -> final');
  console.log(`answer: ${finalAnswer}`);

  kv({
    'messages in array': messages.length,
    'tool calls': toolUses.length,
    ...meter.summary(),
  });
}

await main();
