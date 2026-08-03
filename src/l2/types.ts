/** The Anthropic Messages shape, narrowed to what this demo uses. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Demo-only bookkeeping. Stripped before the message is sent to the API. */
  meta?: { turn?: number; kind?: 'rollup' | 'retrieval' | 'normal' };
}

export const text = (t: string): ContentBlock => ({ type: 'text', text: t });

export const userText = (t: string): Message => ({ role: 'user', content: [text(t)] });

export const assistantText = (t: string): Message => ({ role: 'assistant', content: [text(t)] });

export function toolUses(msg: Message): Extract<ContentBlock, { type: 'tool_use' }>[] {
  return msg.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
}

/** Strip demo metadata before sending. */
export function wireFormat(messages: Message[]): { role: string; content: ContentBlock[] }[] {
  return messages.map(({ role, content }) => ({ role, content }));
}
