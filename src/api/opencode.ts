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

export async function fetchAgents(): Promise<OpenCodeAgentInfo[]> {
  try {
    const response = await fetch(`${baseUrl()}/agent`, { headers: headers() });
    if (!response.ok) throw new Error(`Failed to fetch agents (${response.status})`);
    const json = await response.json();
    // v2 wraps in { data: [...] }, v1 returns array directly
    const list = Array.isArray(json) ? json : json.data;
    return Array.isArray(list) ? list : [];
  } catch (error) {
    console.error('Error fetching agents:', error);
    return [];
  }
}

export async function fetchAgent(agentId: string): Promise<OpenCodeAgentInfo | null> {
  try {
    const response = await fetch(`${baseUrl()}/agent/${agentId}`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to fetch agent');
    return await response.json();
  } catch (error) {
    console.error('Error fetching agent:', error);
    return null;
  }
}

export async function createSession(agentId: string, title?: string): Promise<OpenCodeSessionInfo | null> {
  try {
    const response = await fetch(`${baseUrl()}/session`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ agent: agentId, title }),
    });
    if (!response.ok) throw new Error('Failed to create session');
    return await response.json();
  } catch (error) {
    console.error('Error creating session:', error);
    return null;
  }
}

export async function getSession(sessionId: string): Promise<OpenCodeSessionInfo | null> {
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to get session');
    return await response.json();
  } catch (error) {
    console.error('Error getting session:', error);
    return null;
  }
}

export async function sendPrompt(sessionId: string, message: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl()}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message }),
    });
    return response.ok;
  } catch (error) {
    console.error('Error sending prompt:', error);
    return false;
  }
}

export async function listSessions(): Promise<OpenCodeSessionInfo[]> {
  try {
    const response = await fetch(`${baseUrl()}/session`, { headers: headers() });
    if (!response.ok) throw new Error('Failed to list sessions');
    const json = await response.json();
    const list = Array.isArray(json) ? json : json.data;
    return Array.isArray(list) ? list : [];
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
