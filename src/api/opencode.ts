import { OpenCodeAgentInfo, OpenCodeSessionInfo } from '../types';

const BASE_URL = '/api';

export async function fetchAgents(): Promise<OpenCodeAgentInfo[]> {
  try {
    const response = await fetch(`${BASE_URL}/agent`);
    if (!response.ok) throw new Error('Failed to fetch agents');
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching agents:', error);
    return [];
  }
}

export async function fetchAgent(agentId: string): Promise<OpenCodeAgentInfo | null> {
  try {
    const response = await fetch(`${BASE_URL}/agent/${agentId}`);
    if (!response.ok) throw new Error('Failed to fetch agent');
    return await response.json();
  } catch (error) {
    console.error('Error fetching agent:', error);
    return null;
  }
}

export async function createSession(agentId: string, title?: string): Promise<OpenCodeSessionInfo | null> {
  try {
    const response = await fetch(`${BASE_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch(`${BASE_URL}/session/${sessionId}`);
    if (!response.ok) throw new Error('Failed to get session');
    return await response.json();
  } catch (error) {
    console.error('Error getting session:', error);
    return null;
  }
}

export async function sendPrompt(sessionId: string, message: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const response = await fetch(`${BASE_URL}/session`);
    if (!response.ok) throw new Error('Failed to list sessions');
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error listing sessions:', error);
    return [];
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/session/${sessionId}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch (error) {
    console.error('Error deleting session:', error);
    return false;
  }
}

export async function interruptSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/session/${sessionId}/interrupt`, {
      method: 'POST',
    });
    return response.ok;
  } catch (error) {
    console.error('Error interrupting session:', error);
    return false;
  }
}

export async function getServerInfo(): Promise<any> {
  try {
    const response = await fetch(`${BASE_URL}/info`);
    if (!response.ok) throw new Error('Failed to get server info');
    return await response.json();
  } catch (error) {
    console.error('Error getting server info:', error);
    return null;
  }
}
