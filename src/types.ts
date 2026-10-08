export type TaskStatus = 'backlog' | 'running' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  agentId?: string;
  agentName?: string;
  sessionId?: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  agentIds: string[];
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  color?: string;
}

export interface Session {
  id: string;
  title?: string;
  agent?: string;
  status?: string;
}

export interface OpenCodeAgentInfo {
  id: string;
  name: string;
  description?: string;
  color?: string;
  model?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  agent?: string;
  model?: string;
  time?: {
    created?: string;
    updated?: string;
  };
  messages?: Array<{
    id: string;
    role: string;
    content?: string;
  }>;
}
