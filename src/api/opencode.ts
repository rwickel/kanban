import { OpenCodeAgentInfo, OpenCodeSessionInfo } from '../types';
import { getServerConfig, getAuthHeader } from '../store/serverConfig';

function baseUrl(): string {
  const { url } = getServerConfig();
  // Normalize: strip trailing slash, ensure /api suffix for v2
  const clean = url.replace(/\/+$/, '');
  return clean.endsWith('/api') ? clean : `${clean}/api`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...getAuthHeader(), ...extra };
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

export async function createSession(opts?: {
  title?: string;
  parentID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  directory?: string;
}): Promise<OpenCodeSessionInfo | null> {
  try {
    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    if (opts?.parentID) body.parentID = opts.parentID;
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;
    // Only send location for absolute server-side paths — a bare folder
    // name ("work") makes POST /api/session 500 on the server. Omit it
    // so the session falls back to the server cwd instead of failing.
    const dir = opts?.directory?.trim();
    if (dir && (/^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\') || dir.startsWith('/'))) {
      body.location = { directory: dir };
    } else if (dir) {
      console.warn(`createSession: ignoring relative directory "${dir}" — fix the project path to an absolute server path`);
    }
    const response = await fetch(`${baseUrl()}/session`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error('createSession failed:', response.status, await response.text().catch(() => ''));
      return null;
    }
    return unwrapData<OpenCodeSessionInfo>(await response.json());
  } catch (error) {
    console.error('Error creating session:', error);
    return null;
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
  agentName?: string
): Promise<boolean> {
  // v2: POST /api/session/{id}/prompt { text, agents?, ... } → { data: Session.Inbox.User }
  try {
    const body: Record<string, unknown> = { text };
    if (agentName) body.agents = [{ name: agentName }];
    const res = await fetch(`${baseUrl()}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('sendPrompt failed:', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error sending prompt:', error);
    return false;
  }
}

export async function fetchSessionMessages(sessionId: string): Promise<unknown[] | null> {
  // v2: GET /api/session/{id}/message?limit&order → { data: [...], cursor }
  try {
    const res = await fetch(`${baseUrl()}/session/${sessionId}/message?limit=100&order=asc`, { headers: headers() });
    if (!res.ok) {
      console.error('fetchSessionMessages failed:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const json = await res.json();
    const list = unwrapData<unknown>(json);
    return Array.isArray(list) ? list : null;
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

/** Test the connection with a given url/password. Returns agent count or -1 on failure. */
export async function testConnection(url: string, password: string): Promise<{ ok: boolean; agentCount: number; status?: number }> {
  try {
    const clean = url.replace(/\/+$/, '');
    const base = clean.endsWith('/api') ? clean : `${clean}/api`;
    const h: Record<string, string> = {};
    if (password) h.Authorization = `Basic ${btoa(`opencode:${password}`)}`;
    const response = await fetch(`${base}/agent`, { headers: h });
    if (!response.ok) return { ok: false, agentCount: 0, status: response.status };
    const json = await response.json();
    const list = Array.isArray(json) ? json : json.data;
    return { ok: true, agentCount: Array.isArray(list) ? list.length : 0 };
  } catch {
    return { ok: false, agentCount: 0 };
  }
}
