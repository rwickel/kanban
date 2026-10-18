import type { OpenCodeAgentInfo, OpenCodeModelInfo, OpenCodeSessionInfo } from '../types';

// Browser never holds the OpenCode password. All OpenCode traffic goes
// through Vite's /api/kanban/oc/* proxy, which injects Basic auth server-side
// from the ignored root .env. So baseUrl is fixed and headers
// carry no secret.
function baseUrl(): string {
  return '/api/kanban/oc';
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra };
}

function unwrapData<T>(json: unknown): T {
  // v2 envelope: { location, data } or { data }
  if (json && typeof json === 'object' && 'data' in (json as Record<string, unknown>)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

export async function fetchAgents(directory?: string): Promise<OpenCodeAgentInfo[]> {
  try {
    const q = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await fetch(`${baseUrl()}/agent${q}`, { headers: headers() });
    if (!response.ok) throw new Error(`Failed to fetch agents (${response.status})`);
    const json = await response.json();
    // v2: { location, data: [...] }
    const list = unwrapData<unknown>(json);
    return Array.isArray(list) ? (list as OpenCodeAgentInfo[]) : [];
  } catch (error) {
    console.error('Error fetching agents:', error);
    return [];
  }
}

export async function fetchAgent(agentId: string): Promise<OpenCodeAgentInfo | null> {
  try {
    const response = await fetch(`${baseUrl()}/agent/${agentId}`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to fetch agent');
    return unwrapData<OpenCodeAgentInfo>(await response.json());
  } catch (error) {
    console.error('Error fetching agent:', error);
    return null;
  }
}

/** GET /model → { data: Model.Info[] }. Each carries providerID + modelID. */
export async function fetchModels(): Promise<OpenCodeModelInfo[]> {
  try {
    const response = await fetch(`${baseUrl()}/model`, { headers: headers() });
    if (!response.ok) throw new Error(`Failed to fetch models (${response.status})`);
    const list = unwrapData<unknown>(await response.json());
    const raw = Array.isArray(list) ? (list as OpenCodeModelInfo[]) : [];
    // Dedupe: server can return the same providerID/modelID twice
    // (e.g. google/gemma-3-12b-it) which trips React's duplicate-key warning.
    const seen = new Set<string>();
    const out: OpenCodeModelInfo[] = [];
    for (const m of raw) {
      const key = `${m?.providerID ?? ''}/${m?.modelID ?? m?.id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    out.sort((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`));
    return out;
  } catch (error) {
    console.error('Error fetching models:', error);
    return [];
  }
}

export async function createSession(opts?: {
  title?: string;
  parentID?: string;
  agent?: string;
  model?: { providerID: string; id: string };
  directory?: string;
}): Promise<{ session: OpenCodeSessionInfo | null; error?: string }> {
  try {
    const body: Record<string, unknown> = {};
    // NOTE: v2 POST /api/session schema is { id?, agent?, model?, location? }
    // (additionalProperties: false) — sending `title`/`parentID` can 400/500
    // the create, so only send the allow-listed keys.
    if (opts?.parentID) body.parentID = opts.parentID;
    if (opts?.agent) body.agent = opts.agent;
    // Only send model when both halves are non-empty — a half-filled
    // Model.Ref ({providerID, id: undefined}) makes POST /session 400
    // "Missing key at [model][id]".
    if (opts?.model?.providerID && opts?.model?.id) body.model = opts.model;
    // Only send location for absolute server-side paths — a bare folder
    // name ("work") makes POST /api/session 500 on the server, and omitting
    // it silently lands the session in the server cwd (wrong project).
    // Fail fast so the UI can tell the user to fix the project path.
    const dir = opts?.directory?.trim();
    if (dir) {
      if (/^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\') || dir.startsWith('/')) {
        body.location = { directory: dir };
      } else {
        return { session: null, error: `relative project path "${dir}" — OpenCode needs an absolute server-side path (e.g. C:\\projects\\my-app). Fix it in Project settings.` };
      }
    } else {
      return { session: null, error: 'missing project path — set an absolute server-side path in Project settings before moving to running.' };
    }
    const response = await fetch(`${baseUrl()}/session`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('createSession failed:', response.status, text);
      return { session: null, error: `session create failed (HTTP ${response.status}) — ${text.slice(0, 300)}` };
    }
    const session = unwrapData<OpenCodeSessionInfo>(await response.json());
    if (!session?.id) return { session: null, error: 'session create returned no id' };
    return { session };
  } catch (error) {
    console.error('Error creating session:', error);
    return { session: null, error: `network error — is the OpenCode server running at ${baseUrl()}?` };
  }
}

export async function moveSession(sessionId: string, directory: string): Promise<boolean> {
  // POST /api/session/{id}/move { directory, delivery? } → 204
  try {
    const res = await fetch(`${baseUrl()}/session/${sessionId}/move`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ directory }),
    });
    if (!res.ok) {
      console.error('moveSession failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error moving session:', error);
    return false;
  }
}

export async function getSession(sessionId: string): Promise<OpenCodeSessionInfo | null> {
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}`, { headers: headers() });
    if (!response.ok) {
      if (response.status === 404) return null;
      console.error('getSession failed:', response.status, await response.text().catch(() => ''));
      return null;
    }
    return unwrapData<OpenCodeSessionInfo>(await response.json());
  } catch (error) {
    console.error('Error getting session:', error);
    return null;
  }
}

export async function sendPrompt(
  sessionId: string,
  text: string,
  model?: string
): Promise<{ ok: boolean; error?: string }> {
  // v2: POST /api/session/{id}/prompt { text, ... } → { data: Session.Inbox.User }
  // NOTE: session is already created with its agent — sending `agents` again
  // can 500 the server (unknown id, stale display name). Text-only is safest.
  try {
    const body: Record<string, unknown> = { text };
    if (model) {
      const [providerID, ...rest] = model.split('/');
      const modelID = rest.join('/');
      if (providerID && modelID) body.model = { providerID, id: modelID };
    }
    const res = await fetch(`${baseUrl()}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('sendPrompt failed:', res.status, text);
      const hint =
        res.status === 401 ? 'unauthorized (401) — check Server password'
        : res.status === 404 ? `session not found (404) — ${sessionId} may have been pruned on server restart`
        : res.status === 500 ? `server error (500) — ${text.slice(0, 200)}`
        : `HTTP ${res.status} — ${text.slice(0, 200)}`;
      return { ok: false, error: hint };
    }
    return { ok: true };
  } catch (error) {
    console.error('Error sending prompt:', error);
    return { ok: false, error: `network error — is the OpenCode server running at ${baseUrl()}?` };
  }
}

export async function forkSession(sessionId: string, before: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl()}/session/${sessionId}/fork`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ before }) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const data = unwrapData<{ id?: string; sessionID?: string }>(await res.json());
    const id = data?.id ?? data?.sessionID;
    return id ? { ok: true, sessionId: id } : { ok: false, error: 'Fork response did not include a session id' };
  } catch (error) { return { ok: false, error: String((error as Error).message || error) }; }
}

export async function switchSessionModel(sessionId: string, model: string): Promise<boolean> {
  const [providerID, ...rest] = model.split('/');
  const id = rest.join('/');
  if (!providerID || !id) return false;
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}/model`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: { providerID, id } }),
    });
    if (!response.ok) {
      console.error('switchSessionModel failed:', response.status, await response.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error switching session model:', error);
    return false;
  }
}

export async function switchSessionAgent(sessionId: string, agent: string): Promise<boolean> {
  if (!agent.trim()) return false;
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}/agent`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agent: agent.trim() }),
    });
    if (!response.ok) {
      console.error('switchSessionAgent failed:', response.status, await response.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error switching session agent:', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session instruction entries (board assistant preamble).
//
// Path + payload confirmed live against https://opencode.ai/v2/openapi.json
// and a real `opencode serve` on 2026-10-13 (see plans/board-assistant-preamble-plan.md,
// "Step 1 decision log"):
//   PUT    /api/experimental/session/{id}/instructions/entries/{key}  → 204
//          body { "value": <string> }   ← `value`, NOT `content`/`text` (those 400)
//   GET    /api/experimental/session/{id}/instructions/entries        → { data: [{ key, value }] }
//   DELETE /api/experimental/session/{id}/instructions/entries/{key}  → 204
// The plain `/api/session/...` variant 404s. Errors: 400 / 401 / 404 /
// 413 (InstructionEntryValueTooLargeError).
// NOTE: the board result-capture cap (vite.config.js capResult, 4000 chars)
// is deliberately NOT applied here — it would truncate the preamble itself.
// ---------------------------------------------------------------------------

function instructionsUrl(sessionId: string, key?: string): string {
  const base = `${baseUrl()}/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries`;
  return key ? `${base}/${encodeURIComponent(key)}` : base;
}

/** Attach or replace one durable instruction entry. Never throws.
 *  Bounded by a 5s timeout so a hung socket can't stall session creation. */
export async function putSessionInstruction(
  sessionId: string,
  key: string,
  value: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(instructionsUrl(sessionId, key), {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ value }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`putSessionInstruction(${key}) failed:`, res.status, text.slice(0, 200));
        return { ok: false, status: res.status, error: `HTTP ${res.status} — ${text.slice(0, 200)}` };
      }
      return { ok: true, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error('Error writing session instruction:', error);
    return { ok: false, error: String(error) };
  }
}

/** Read one instruction entry by key. The spec has no single-key GET
 *  (list path GETs, key path PUT/DELETEs), so list and find. Returns null
 *  when absent or unreadable. */
export async function getSessionInstruction(
  sessionId: string,
  key: string
): Promise<string | null> {
  try {
    const res = await fetch(instructionsUrl(sessionId), { headers: headers() });
    if (!res.ok) return null;
    const json = await res.json();
    // Envelope is { data: [{ key, value }] } — find our key.
    const list = unwrapData<unknown>(json);
    if (!Array.isArray(list)) return null;
    const entry = list.find(
      (e) => e && typeof e === 'object' && (e as { key?: string }).key === key
    );
    const value = (entry as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' ? value : null;
  } catch (error) {
    console.error('Error reading session instruction:', error);
    return null;
  }
}

export async function fetchSessionMessages(sessionId: string): Promise<unknown[] | null> {
  // v2: GET /api/session/{id}/message?limit&order → { data: [...], cursor }
  try {
    const res = await fetch(`${baseUrl()}/session/${sessionId}/message?limit=100&order=desc`, { headers: headers() });
    if (!res.ok) {
      console.error('fetchSessionMessages failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = await res.json();
    const list = unwrapData<unknown>(json);
    return Array.isArray(list) ? [...list].reverse() : null;
  } catch (error) {
    console.error('Error fetching session messages:', error);
    return null;
  }
}

export async function getServerPath(): Promise<string | null> {
  // v2: location lives on GET /api/info or /api/location
  try {
    const res = await fetch(`${baseUrl()}/location`, { headers: headers() });
    if (!res.ok) return null;
    const obj = unwrapData<any>(await res.json());
    if (typeof obj === 'string') return obj;
    return obj?.directory ?? obj?.path ?? null;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<OpenCodeSessionInfo[]> {
  try {
    const response = await fetch(`${baseUrl()}/session`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to list sessions');
    const list = unwrapData<unknown>(await response.json());
    return Array.isArray(list) ? (list as OpenCodeSessionInfo[]) : [];
  } catch (error) {
    console.error('Error listing sessions:', error);
    return [];
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    return response.ok;
  } catch (error) {
    console.error('Error deleting session:', error);
    return false;
  }
}

export async function interruptSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}/interrupt`, {
      method: 'POST',
      headers: headers(),
    });
    return response.ok;
  } catch (error) {
    console.error('Error interrupting session:', error);
    return false;
  }
}

/**
 * Answer a blocked `question` tool.
 *
 * There is no dedicated question route on this server: the question tool
 * blocks on a *form* (`metadata.kind: "question"`, linked to the tool's
 * messageID/callID) and wakes when that form is answered:
 *
 *   GET  /session/{id}/form              → pending forms
 *   POST /session/{id}/form/{formID}/reply  { answer: { q0, q1, … } }
 *
 * The answer object is keyed by field key (q0, q1, …). Each value matches the
 * field type: a string field takes a label string, a multiselect takes a
 * label array. Uses the shared Vite proxy (/api/kanban/oc) so no password
 * lives in the browser.
 */
export async function answerTool(
  sessionId: string,
  toolCallId: string,
  answer: Record<string, string | string[]>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // 1. Find the pending question form that belongs to this tool call.
    const listRes = await fetch(`${baseUrl()}/session/${sessionId}/form`, { headers: headers() });
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '');
      return { ok: false, error: `list failed HTTP ${listRes.status} — ${body.slice(0, 300)}` };
    }
    const listJson = await listRes.json().catch(() => ({}));
    const payload = (listJson && typeof listJson === 'object' && 'data' in listJson)
      ? (listJson as { data: unknown }).data
      : listJson;
    type QForm = { id?: string; metadata?: { kind?: string; tool?: { id?: string } } };
    const pending: QForm[] = Array.isArray(payload) ? payload : [];

    const hit = pending.find((f) => f?.metadata?.tool?.id === toolCallId)
      // No form still carries this call id (already answered?) — surface that
      // instead of answering a sibling's question.
      ?? null;
    if (!hit?.id) return { ok: false, error: 'question already answered or closed' };

    // 2. Reply with the per-field answers.
    const res = await fetch(
      `${baseUrl()}/session/${sessionId}/form/${encodeURIComponent(hit.id)}/reply`,
      {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ answer }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} — ${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}

/** SSE bus: GET /api/event streams server events (needs auth header — EventSource
 *  can't set headers, so we fetch+parse the stream manually). Calls onEvent
 *  for frames mentioning the session. Returns an unsubscribe fn. */
export function subscribeSessionEvents(sessionId: string, onEvent: () => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${baseUrl()}/event`, {
        headers: { ...headers(), Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) {
          if (f.includes(sessionId)) onEvent();
        }
      }
    } catch {
      /* abort or network — polling covers us */
    }
  })();
  return () => ctrl.abort();
}

export async function getServerInfo(): Promise<any> {
  try {
    const response = await fetch(`${baseUrl()}/info`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to get server info');
    return await response.json();
  } catch (error) {
    console.error('Error getting server info:', error);
    return null;
  }
}

/** Test the connection via the server-side proxy (password never stored in browser). */
export async function testConnection(): Promise<{ ok: boolean; agentCount: number; status?: number }> {
  try {
    const res = await fetch('/api/kanban/server/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, agentCount: 0, status: j?.status ?? res.status };
    }
    const j = await res.json();
    return { ok: true, agentCount: j.agentCount ?? 0 };
  } catch {
    return { ok: false, agentCount: 0 };
  }
}

/** Does the server have OpenCode creds stored? (password never leaves the server) */
export async function getServerCredsState(): Promise<{ url: string; hasPassword: boolean }> {
  try {
    const res = await fetch('/api/kanban/server');
    if (!res.ok) return { url: '', hasPassword: false };
    return await res.json();
  } catch {
    return { url: '', hasPassword: false };
  }
}
