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

export interface MessageMeta {
  agent?: string;
  model?: string;
  /** Wall time for this message in ms (duration or timestamp delta). */
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export interface ChatMessage {
  /** message id (msg_...) — stable across polls */
  id: string;
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'error';
  /** Markdown body for user/assistant/reasoning/error messages. */
  markdown: string;
  tool?: ToolCallInfo;
  /** Per-message provenance: agent/model/timing/tokens when the server reports them. */
  meta?: MessageMeta;
}

type Payload = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One-line summary of a nested Code Mode subcall input — never raw JSON. */
function summarizeCallInput(tool: string, input: Payload, full = false): string {
  const name = tool || 'call';
  const keys = Object.keys(input);
  if (keys.length === 0) return `${name}()`;
  // Compact fetch rows: "GET <url>" instead of "fetch(method: GET · url: …)".
  if (name.toLowerCase() === 'fetch') {
    const url = typeof input.url === 'string' ? input.url : '';
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
    if (url) return full ? `${method} ${url}` : `${method} ${url.length > 100 ? `${url.slice(0, 100)}…` : url}`;
  }
  const lines = keys.map((k) => {
    let v: string;
    try {
      v = typeof input[k] === 'string' ? (input[k] as string) : JSON.stringify(input[k]);
    } catch { v = String(input[k]); }
    const cap = full ? 500 : 120;
    if (v.length > cap) v = `${v.slice(0, cap)}…`;
    return `${k}: ${v}`;
  });
  return `${name}(${lines.join(full ? '\n' : ' · ')})`;
}

/** Tool display name: v2 puts it in part.name, older shapes in part.tool. */
function partToolName(part: Payload): string {
  return str(part.tool) || str(part.name) || 'tool';
}

/** "action → output" one-liner, never raw JSON. */
function toolSummary(part: Payload): string {
  const input = toolInput(part);
  const action = input.action || partToolName(part);
  return input.brief || action;
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
      // Only collapse the envelope when it actually carries data/error —
      // otherwise keep the raw text (e.g. execute results like {a, b}).
      if (str(o.error)) output = `error: ${str(o.error)}`;
      else if (o.data != null && typeof o.data !== 'object') output = String(o.data);
      else if (o.data != null) output = JSON.stringify(o.data).slice(0, 2000);
    }
  } catch {
    /* not JSON — keep raw */
  }

  // Rich render detection
  const toolName = partToolName(part).toLowerCase();

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
  const tName = partToolName(part);
  // Plain-tool rows stay minimal: just the name (+ URL), never the output dump.
  if (['webfetch', 'websearch', 'fetch', 'search'].includes(toolName)) {
    const brief = command || (path ? `${tName} ${path}` : '') || pattern || tName;
    return { action: brief.slice(0, 200), brief: brief.slice(0, 200), input: '', output: '', render: 'generic' as const, diff: undefined, filePath: path || undefined, questions: undefined, todos: undefined };
  }
  const action =
    command || (path ? `${tName} ${path}` : '') || pattern || tName;

  // Brief one-liner: action → output, capped
  const briefOut = output.replace(/\s+/g, ' ').trim().slice(0, 120);
  const brief = [action, briefOut].filter(Boolean).join(' → ').slice(0, 200);

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
  // When we have a diff render (edit/write) the diff panel already shows the
  // content, so we keep Input to just the path to avoid duplicating the body.
  const hasDiff = render === 'diff' && !!diff && diff.length > 0;
  const inputLines: string[] = [];
  if (command) inputLines.push(`$ ${command}`);
  if (path) inputLines.push(path);
  if (!command && !path && pattern) inputLines.push(pattern);
  if (!hasDiff && text && text !== command) inputLines.push(text.length > 2000 ? `${text.slice(0, 2000)}\n… (truncated)` : text);
  if (inputLines.length === 0) {
    try {
      const raw = JSON.stringify(rawInput);
      if (raw && raw !== '{}') inputLines.push(raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw);
    } catch { /* ignore */ }
  }
  const input = inputLines.join('\n');
  return { action, brief, input, output: output.length > 4000 ? `${output.slice(0, 4000)}\n… (truncated)` : output, render, diff, filePath, questions, todos };
}

function contentToMessages(id: string, kind: 'user' | 'assistant', part: Payload, meta?: MessageMeta): ChatMessage[] {
  const type = str(part.type);
  switch (type) {
    case 'text': {
      const text = str(part.text).trim();
      if (!text) return [];
      return [{ id, kind, markdown: text, ...(meta ? { meta } : {}) }];
    }
    case 'reasoning': {
      const text = str(part.text).trim();
      if (!text) return [];
      return [{ id: `${id}-reasoning`, kind: 'reasoning', markdown: text, ...(meta ? { meta } : {}) }];
    }
    case 'tool': {
      const state = (part.state as Payload | undefined) ?? {};
      const status = str(state.status) || 'pending';
      const execErr = str(state.error);
      const exec = (part as Record<string, unknown>).executed as boolean | undefined;
      if (status === 'error' || execErr) {
        return [{
          id: `${id}-tool`,
          kind: 'error',
          markdown: execErr || toolSummary(part) || 'Tool call failed.',
        }];
      }
      // Code Mode `execute` wrapper: { type:"tool", name:"execute", ...,
      //   metadata.toolCalls: [{tool:"search", input:{...}}, ...] } plus one
      //   giant nested content dump. Render each inner call as its own compact
      //   row instead of the raw JSON blob.
      if ((str(part.name) || str(part.tool)).toLowerCase() === 'execute') {
        const meta = (part.metadata ?? (state as Payload).metadata) as Payload | undefined;
        const calls = meta && Array.isArray(meta.toolCalls) ? (meta.toolCalls as Payload[]) : [];
        const innerInput = ((state.input as Payload | undefined) ?? {}) as Payload;
        const code = str(innerInput.code).slice(0, 2000);
        if (calls.length > 0) {
          return calls.map((c, i) => ({
            id: `${id}-tool-${i}`,
            kind: 'tool' as const,
            markdown: '',
            tool: {
              tool: str(c.tool) || 'subcall',
              status: str(c.status) || 'completed',
              summary: summarizeCallInput(str(c.tool), (c.input ?? {}) as Payload),
              input: summarizeCallInput(str(c.tool), (c.input ?? {}) as Payload, true),
              output: '',
              render: 'generic' as const,
            },
          }));
        }
        void code;
      }
      const detail = toolInput(part);
      // Treat both executed:true and status:completed as "executed" (v2 sends completed)
      const executed = exec === true || status === 'completed';
      const st = executed ? 'executed' : status;
      return [{
        id: `${id}-tool`,
        kind: 'tool',
        markdown: '',
        tool: {
          tool: partToolName(part),
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
      return [{ id: `${id}-file`, kind: 'assistant', markdown: `📎 ${name}`, ...(meta ? { meta } : {}) }];
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
function extractMeta(raw: Payload): MessageMeta | undefined {
  // OpenCode v2 per-message provenance may live on m.model / m.agent /
  // m.time / m.tokens / m.cost or nested under m.info. Probe broadly but
  // defensively — never throw. Unimplemented fields stay undefined.
  const get = (obj: Payload, ...keys: string[]): unknown => {
    for (const k of keys) {
      if (obj[k] != null) return obj[k];
    }
    return undefined;
  };
  const toNum = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const toModelStr = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const o = v as Payload;
      const prov = typeof o.providerID === 'string' ? o.providerID : '';
      const mid = (typeof o.modelID === 'string' ? o.modelID : '') || (typeof o.id === 'string' ? o.id : '');
      if (prov && mid) return `${prov}/${mid}`;
      if (mid) return mid;
    }
    return undefined;
  };
  const toMs = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
    if (typeof v === 'string') {
      const n = Date.parse(v);
      if (Number.isFinite(n)) return n;
      const asNum = Number(v);
      if (Number.isFinite(asNum)) return asNum;
    }
    return undefined;
  };

  const pools: Payload[] = [];
  if (raw.agent || raw.model || raw.time || raw.tokens || raw.cost || raw.usage || raw.elapsed) pools.push(raw);
  if (raw.info && typeof raw.info === 'object') pools.push(raw.info as Payload);
  if (raw.metadata && typeof raw.metadata === 'object') pools.push(raw.metadata as Payload);
  // message may carry `participants` / `agents` array — grab first name
  const agentsPool = get(raw, 'agents', 'participants');
  if (Array.isArray(agentsPool) && agentsPool.length > 0) {
    const first = agentsPool[0] as Payload;
    pools.push({ __agentName: typeof first?.name === 'string' ? first.name : typeof first === 'string' ? first : undefined });
  }

  let agent: string | undefined;
  let model: string | undefined;
  let elapsedMs: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let cost: number | undefined;

  for (const p of pools) {
    if (!agent) agent = (p.__agentName as string) || (typeof p.agent === 'string' ? p.agent.trim() : undefined);
    if (!agent && typeof p.agent === 'object' && p.agent) {
      const a = p.agent as Payload;
      agent = (a.name as string) || (a.id as string) || undefined;
    }
    if (!model) model = toModelStr(p.model) ?? toModelStr(p.variant) ?? toModelStr(get(p, 'modelRef', 'modelInfo'));
    // elapsed: durationMs / elapsed / duration / time.*
    if (elapsedMs == null) {
      const cand = get(p, 'durationMs', 'duration', 'elapsedMs', 'elapsed', 'timeMs');
      if (cand != null) elapsedMs = toNum(cand) ?? (typeof cand === 'string' ? toNum(cand) : undefined);
      if (elapsedMs == null && p.time && typeof p.time === 'object') {
        const t = p.time as Payload;
        const s = toMs(t.start ?? t.created ?? t.started);
        const e = toMs(t.end ?? t.finished ?? t.completed ?? t.updated);
        if (s != null && e != null && e >= s) elapsedMs = e - s;
        else if (typeof t.duration === 'number') elapsedMs = t.duration;
      }
      if (elapsedMs == null && typeof get(p, 'timestamp', 'created', 'updated') === 'number') {
        // bare timestamp — not elapsed, skip
      }
    }
    // tokens: tokens / usage / tokenUsage — check nested first
    const tkPools: Payload[] = [];
    if (p.tokens && typeof p.tokens === 'object') tkPools.push(p.tokens as Payload);
    if (p.usage && typeof p.usage === 'object') tkPools.push(p.usage as Payload);
    if ((p as Record<string, unknown>).tokenUsage && typeof (p as Record<string, unknown>).tokenUsage === 'object') tkPools.push((p as Record<string, unknown>).tokenUsage as Payload);
    if (tkPools.length === 0 && (get(p, 'inputTokens', 'outputTokens', 'totalTokens', 'promptTokens', 'completionTokens') != null)) tkPools.push(p);
    for (const tp of tkPools) {
      if (inputTokens == null) inputTokens = toNum(get(tp, 'input', 'inputTokens', 'promptTokens', 'prompt_tokens'));
      if (outputTokens == null) outputTokens = toNum(get(tp, 'output', 'outputTokens', 'completionTokens', 'completion_tokens'));
      if (reasoningTokens == null) reasoningTokens = toNum(get(tp, 'reasoning', 'reasoningTokens', 'thinkingTokens'));
      if (totalTokens == null) totalTokens = toNum(get(tp, 'total', 'totalTokens', 'total_tokens'));
      if (cost == null) cost = toNum(get(tp, 'cost', 'totalCost', 'price'));
    }
    if (cost == null) cost = toNum(get(p, 'cost', 'totalCost', 'price'));
  }

  if (totalTokens == null && (inputTokens != null || outputTokens != null || reasoningTokens != null)) {
    totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0);
  }

  const hasAny = agent || model || elapsedMs != null || inputTokens != null || outputTokens != null || totalTokens != null || cost != null;
  if (!hasAny) return undefined;
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(elapsedMs != null ? { elapsedMs } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
    ...(cost != null ? { cost } : {}),
  };
}

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

  // compaction: silent when ok, visible error row when failed so the
  // chat never looks empty (e.g. provider 404 before any reply).
  if (type === 'compaction') {
    const status = str(m.status).toLowerCase();
    if (status === 'failed' || m.error) {
      const err = m.error as Payload | undefined;
      const msg = str((err as Payload)?.message) || str(m.reason) || 'Compaction failed.';
      return [{ id, kind: 'error', markdown: `Compaction failed (${status || 'error'}): ${msg}`.slice(0, 2000) }];
    }
    return [];
  }

  // idle with a failure outcome (e.g. provider 404): surface it instead
  // of dropping it — otherwise a dead session renders only the prompt.
  // Benign outcomes (completed/done/succeeded/…) stay silent; the stream
  // status still flips to closed. Anything else is a real failure.
  if (type === 'idle') {
    const outcome = str(m.outcome).toLowerCase();
    if (outcome && !['completed', 'done', 'succeeded', 'success', 'interrupted', 'aborted'].includes(outcome)) {
      return [{ id: `${id}-outcome`, kind: 'error', markdown: `Session ended: ${outcome}.` }];
    }
    return [];
  }

  // idle / compaction / agent-switched / ... without content: noise
  const content = Array.isArray(m.content) ? (m.content as Payload[]) : [];
  if (content.length === 0) return [];

  const out: ChatMessage[] = [];
  const meta = extractMeta(m);
  for (const part of content) {
    if (part && typeof part === 'object') out.push(...contentToMessages(id, 'assistant', part, meta));
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

/** Serialize the current chat feed to Markdown (user/assistant text, thinking, tool calls). */
export function chatToMarkdown(messages: ChatMessage[], opts?: { title?: string; sessionId?: string | null; agentName?: string }): string {
  const lines: string[] = [];
  if (opts?.title) lines.push(`# ${opts.title}`, '');
  const meta: string[] = [];
  if (opts?.agentName) meta.push(`agent: ${opts.agentName}`);
  if (opts?.sessionId) meta.push(`session: ${opts.sessionId}`);
  if (meta.length) lines.push(`_${meta.join(' · ')}_`, '');
  for (const m of messages) {
    const mBits: string[] = [];
    if (m.kind !== 'user' && m.meta) {
      if (m.meta.agent) mBits.push(`agent: ${m.meta.agent}`);
      if (m.meta.model) mBits.push(`model: ${m.meta.model}`);
      const mIn = m.meta.inputTokens ?? 0;
      const mOut = m.meta.outputTokens ?? 0;
      const mReas = m.meta.reasoningTokens ?? 0;
      const tot = m.meta.totalTokens ?? (mIn + mOut + mReas);
      if (tot > 0 || mIn > 0 || mOut > 0) mBits.push(`input: ${Math.round(mIn).toLocaleString('en-US')} · output: ${Math.round(mOut).toLocaleString('en-US')}${mReas > 0 ? ` · reasoning: ${Math.round(mReas).toLocaleString('en-US')}` : ''} · total: ${Math.round(tot).toLocaleString('en-US')}`);
      if (m.meta.elapsedMs != null) {
        const es = Math.floor(m.meta.elapsedMs / 1000);
        mBits.push(`elapsed: ${es < 60 ? `${es}s` : `${Math.floor(es / 60)}m ${String(es % 60).padStart(2, '0')}s`}`);
      }
      if (m.meta.cost != null && m.meta.cost > 0) mBits.push(`cost: $${m.meta.cost.toFixed(4)}`);
    }
    const mSuffix = mBits.length > 0 ? ` _(${mBits.join(' · ')})_` : '';
    if (m.kind === 'user') {
      lines.push(`## 🧑 User`, '', m.markdown.trim(), '');
    } else if (m.kind === 'assistant') {
      lines.push(`## 🤖 Assistant${mSuffix}`, '', m.markdown.trim(), '');
    } else if (m.kind === 'reasoning') {
      lines.push(`<details><summary>💭 Thinking</summary>`, '', m.markdown.trim(), '', `</details>`, '');
    } else if (m.kind === 'tool' && m.tool) {
      const t = m.tool;
      lines.push(`### 🔧 \`${t.tool}\` — ${t.status}`);
      if (t.summary) lines.push('', `_${t.summary}_`);
      if (t.filePath) lines.push('', `file: \`${t.filePath}\``);
      if (t.diff && t.diff.length) {
        lines.push('', '```diff');
        for (const d of t.diff) lines.push(`${d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '} ${d.text}`);
        lines.push('```');
      } else if (t.input) {
        lines.push('', '**Input:**', '', '```', t.input.slice(0, 4000), '```');
      }
      if (t.questions) {
        for (const q of t.questions) {
          lines.push('', `**${q.header}: ${q.question}**`);
          for (const o of q.options) lines.push(`- ${o.label}${o.description ? ` — ${o.description}` : ''}`);
        }
      }
      if (t.todos) {
        lines.push('');
        for (const td of t.todos) lines.push(`- [${td.status === 'completed' ? 'x' : ' '}] ${td.content}`);
      }
      if (t.output) lines.push('', '**Result:**', '', '```', t.output.slice(0, 8000), '```');
      lines.push('');
    } else if (m.kind === 'error') {
      lines.push(`### ❌ Error`, '', m.markdown.trim(), '');
    }
  }
  return lines.join('\n').trim() + '\n';
}
