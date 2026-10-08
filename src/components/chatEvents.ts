// OpenCode v2 real shape (from live GET /api/session/{id}/message):
//   { data: [ { id: "msg_...", type: "user"|"assistant"|"idle"|...,
// //             text?, content?: [{type:"text"|"reasoning"|"tool"|..., text?, ...}],
// //             agents?, agent?, model?, ... } ], cursor: {...} }
// user → text field; assistant → content[] parts; idle → protocol noise.

export interface ToolCallInfo {
  tool: string;
  status: string;
  summary: string;
}

export interface ChatMessage {
  /** message id (msg_...) — stable across polls */
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'error';
  /** Markdown body for user/assistant/error messages. */
  markdown: string;
  tool?: ToolCallInfo;
}

type Payload = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "action → output" one-liner, never raw JSON. */
function toolSummary(part: Payload): string {
  const state = (part.state as Payload | undefined) ?? {};
  const input = (state.input as Payload | undefined) ?? {};
  const action = str(input.action) || str(input.tool) || str(part.tool) || 'call';
  let output = str(state.output) || str(state.title) || str(state.summary);
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Payload;
      output = str(o.error) ? `error: ${str(o.error)}` : o.data != null ? String(o.data) : '';
    }
  } catch {
    /* not JSON — keep raw, truncated below */
  }
  return [action, output].filter(Boolean).join(' → ').slice(0, 200);
}

function contentToMessages(id: string, kind: 'user' | 'assistant', part: Payload): ChatMessage[] {
  const type = str(part.type);
  switch (type) {
    case 'text': {
      const text = str(part.text).trim();
      if (!text) return [];
      return [{ id, kind, markdown: text }];
    }
    case 'reasoning': {
      const text = str(part.text).trim();
      if (!text) return [];
      return [{ id: `${id}-reasoning`, kind: 'assistant', markdown: `> ${text}` }];
    }
    case 'tool': {
      const state = (part.state as Payload | undefined) ?? {};
      const status = str(state.status) || 'pending';
      if (status === 'error' || str(state.error)) {
        return [{
          id: `${id}-tool`,
          kind: 'error',
          markdown: str(state.error) || toolSummary(part) || 'Tool call failed.',
        }];
      }
      return [{
        id: `${id}-tool`,
        kind: 'tool',
        markdown: '',
        tool: { tool: str(part.tool) || 'tool', status, summary: toolSummary(part) },
      }];
    }
    case 'file': {
      const name = str(part.filename) || str(part.url) || 'file';
      return [{ id: `${id}-file`, kind: 'assistant', markdown: `📎 ${name}` }];
    }
    // step-start, step-finish, snapshot, patch, compaction etc.: protocol noise
    default:
      return [];
  }
}

/**
 * Convert one raw v2 message item into 0..n chat messages. Returns [] for
 * protocol noise (idle, system markers, empty content).
 */
export function toChatMessage(raw: unknown): ChatMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const m = raw as Payload;
  const id = str(m.id) || str(m.messageID);
  if (!id) return [];
  const type = str(m.type);

  // user / synthetic / system: text lives directly on the message
  if (type === 'user' || type === 'synthetic' || type === 'system') {
    const text = str(m.text).trim();
    if (!text) return [];
    return [{ id, kind: type === 'user' ? 'user' : 'assistant', markdown: text }];
  }

  // idle / compaction / agent-switched / ... without content: noise
  const content = Array.isArray(m.content) ? (m.content as Payload[]) : [];
  if (content.length === 0) return [];

  const out: ChatMessage[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') out.push(...contentToMessages(id, 'assistant', part));
  }
  return out;
}

/** Flatten + dedupe a message list into renderable chat messages. */
export function toChatMessages(rawList: unknown): ChatMessage[] {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const raw of rawList) {
    for (const msg of toChatMessage(raw)) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      out.push(msg);
    }
  }
  return out;
}
