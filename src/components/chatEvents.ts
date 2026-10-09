// OpenCode v2 real shape (from live GET /api/session/{id}/message):
//   { data: [ { id: "msg_...", type: "user"|"assistant"|"idle"|...,
// //             text?, content?: [{type:"text"|"reasoning"|"tool"|..., text?, ...}],
// //             agents?, agent?, model?, ... } ], cursor: {...} }
// user → text field; assistant → content[] parts; idle → protocol noise.

export interface DiffLine { type: 'add' | 'del' | 'ctx' | 'hunk'; text: string }
export interface QuestionOption { label: string; description: string }
export interface QuestionItem { header: string; question: string; options: QuestionOption[]; multiple?: boolean }
export interface TodoItem { content: string; status: string; activeForm?: string }

export interface ToolCallInfo {
  /** e.g. "write", "bash", "read" */
  tool: string;
  /** completed | pending | running | error … */
  status: string;
  /** one-liner: key input → key output */
  summary: string;
  /** full input text (command / path+content …) for the details view */
  input?: string;
  /** full result text for the details view */
  output?: string;
  /** rich render kind */
  render?: 'diff' | 'question' | 'todo' | 'generic';
  diff?: DiffLine[];
  filePath?: string;
  questions?: QuestionItem[];
  todos?: TodoItem[];
}

export interface ChatMessage {
  /** message id (msg_...) — stable across polls */
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'error';
  /** Markdown body for user/assistant/reasoning/error messages. */
  markdown: string;
  tool?: ToolCallInfo;
}

type Payload = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "action → output" one-liner, never raw JSON. */
function toolSummary(part: Payload): string {
  const input = toolInput(part);
  const action = input.action || str(part.tool) || 'call';
  return input.brief;
}

interface ToolDetail { action: string; brief: string; input: string; output: string; render?: 'diff' | 'question' | 'todo' | 'generic'; diff?: DiffLine[]; filePath?: string; questions?: QuestionItem[]; todos?: TodoItem[] }

/** Extract human-readable input/output from a v2 tool part. */
function toolInput(part: Payload): ToolDetail {
  const state = (part.state as Payload | undefined) ?? {};
  const rawInput = (state.input as Payload | undefined) ?? {};
  const outputParts = state.content;
  let output = '';
  if (Array.isArray(outputParts)) {
    output = (outputParts as Payload[])
      .map((c) => str(c.text))
      .filter(Boolean)
      .join('\n');
  }
  if (!output) output = str(state.output) || str(state.title) || str(state.summary);
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Payload;
      output = str(o.error) ? `error: ${str(o.error)}` : o.data != null ? String(o.data) : '';
    }
  } catch {
    /* not JSON — keep raw */
  }

  // Pick the most informative input field per tool
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = rawInput[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const command = pick('command');
  const path = pick('path', 'file', 'filePath', 'filename', 'url');
  const pattern = pick('pattern', 'query');
  const text = pick('text', 'content');
  const action =
    command || (path ? `${str(part.tool) || 'tool'} ${path}` : '') || pattern || str(part.tool) || 'call';

  // Brief one-liner: action → output, capped
  const briefOut = output.replace(/\s+/g, ' ').trim().slice(0, 120);
  const brief = [action, briefOut].filter(Boolean).join(' → ').slice(0, 200);

  // Rich render detection
  const toolName = (str(part.tool) || str(part.name) || '').toLowerCase();
  let render: 'diff' | 'question' | 'todo' | 'generic' = 'generic';
  let diff: DiffLine[] | undefined;
  let questions: QuestionItem[] | undefined;
  let todos: TodoItem[] | undefined;
  const filePath = path || undefined;

  // question tool: rawInput.questions = [{header, question, options:[{label,description}], multiple}]
  const qRaw = (rawInput as Payload)['questions'];
  if (toolName.includes('question') && Array.isArray(qRaw)) {
    render = 'question';
    questions = (qRaw as Payload[]).map((q) => ({
      header: str((q as Payload).header) || 'Question',
      question: str((q as Payload).question),
      multiple: Boolean((q as Payload).multiple),
      options: Array.isArray((q as Payload).options)
        ? ((q as Payload).options as Payload[]).map((o) => ({ label: str(o.label), description: str(o.description) }))
        : [],
    }));
  }
  // todowrite/todo: rawInput.todos = [{content, status, activeForm}]
  const tRaw = (rawInput as Payload)['todos'];
  if (Array.isArray(tRaw) && (toolName.includes('todo') || (tRaw as unknown[]).length > 0 && toolName.includes('write'))) {
    const looksTodo = (tRaw as Payload[]).every((t) => typeof (t as Payload).content === 'string' && typeof (t as Payload).status === 'string');
    if (looksTodo) {
      render = 'todo';
      todos = (tRaw as Payload[]).map((t) => ({ content: str(t.content), status: str(t.status), activeForm: str(t.activeForm) }));
    }
  }
  // write/edit: rawInput.oldString/newString or content → line diff
  const oldS = str((rawInput as Payload).oldString);
  const newS = str((rawInput as Payload).newString) || (toolName.includes('write') ? text : '');
  if (!questions && !todos && (oldS || newS) && (toolName.includes('edit') || toolName.includes('write'))) {
    render = 'diff';
    const olds = oldS ? oldS.split('\n') : [];
    const news = newS ? newS.split('\n') : [];
    diff = [
      ...olds.map((l): DiffLine => ({ type: 'del', text: l })),
      ...news.map((l): DiffLine => ({ type: 'add', text: l })),
    ].slice(0, 60);
  }

  // Full details: command or path+content, then output
  const inputLines: string[] = [];
  if (command) inputLines.push(`$ ${command}`);
  if (path) inputLines.push(path);
  if (!command && !path && pattern) inputLines.push(pattern);
  if (text && text !== command) inputLines.push(text.length > 2000 ? `${text.slice(0, 2000)}\n… (truncated)` : text);
  if (inputLines.length === 0) {
    try {
      const raw = JSON.stringify(rawInput);
      if (raw && raw !== '{}') inputLines.push(raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw);
    } catch { /* ignore */ }
  }
  const input = inputLines.join('\n');
  return { action, brief, input, output: output.length > 4000 ? `${output.slice(0, 4000)}\n… (truncated)` : output, render, diff, filePath, questions, todos };
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
      return [{ id: `${id}-reasoning`, kind: 'reasoning', markdown: text }];
    }
    case 'tool': {
      const state = (part.state as Payload | undefined) ?? {};
      const status = str(state.status) || 'pending';
      const detail = toolInput(part);
      const execErr = str(state.error);
      const exec = (part as Record<string, unknown>).executed as boolean | undefined;
      if (status === 'error' || execErr) {
        return [{
          id: `${id}-tool`,
          kind: 'error',
          markdown: execErr || toolSummary(part) || 'Tool call failed.',
        }];
      }
      // Treat both executed:true and status:completed as "executed" (v2 sends completed)
      const executed = exec === true || status === 'completed';
      const st = executed ? 'executed' : status;
      return [{
        id: `${id}-tool`,
        kind: 'tool',
        markdown: '',
        tool: {
          tool: str(part.name) || str(part.tool) || 'tool',
          status: st,
          summary: detail.brief,
          input: (detail as any).input || (detail as any).action,
          output: (detail as any).output,
          render: (detail as any).render,
          diff: (detail as any).diff,
          filePath: (detail as any).filePath,
          questions: (detail as any).questions,
          todos: (detail as any).todos,
        },
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
  // Keep server content order (reasoning / text / tools as they arrived).
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
