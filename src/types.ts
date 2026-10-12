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
  /** Visible startup state for running tasks: creating session → sending prompt → ready/error */
  startupPhase?: 'creating-session' | 'sending-prompt' | 'ready' | 'error';
  startupError?: string;
  /** "providerID/modelID" e.g. "ollama/gemma4:e2b" — passed to createSession */
  modelId?: string;
  modelProviderID?: string;
  /** Session that created this task (delegation chain) — empty when created by user/board */
  parentSessionId?: string | null;
  /** Last assistant message + context written on done/blocked (or at any time) */
  result?: string | null;
  resultContext?: string | null;
  /** Delivery ledger: ISO timestamp when the finished result was queued back
   *  into the parent session (null = not yet delivered, keep retrying). */
  notifiedAt?: string | null;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  /** Folder name inside KANBAN_PROJECTS_ROOT (portable; path = ROOT/folder). */
  folder?: string;
  /** Origin URL recorded at link/clone time. */
  gitUrl?: string | null;
  /** Pinned branch — tasks warn if checkout differs. */
  gitBranch?: string;
  description: string;
  agentIds: string[];
  createdAt: string;
}

export interface RootsInfo {
  root: string;
  folders: string[];
}

export interface FolderGitInfo {
  folder: string;
  isRepo: boolean;
  branch?: string | null;
  dirty?: boolean;
  remote?: string | null;
  branches?: string[];
}

export interface BranchCheck {
  ok: boolean;
  current?: string | null;
  pinned: string;
  skipped?: string;
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

export interface OpenCodeModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  agent?: string;
  model?: string | { providerID?: string; modelID?: string; id?: string; [k: string]: unknown };
  time?: {
    created?: string | number;
    updated?: string | number;
    [k: string]: unknown;
  };
  tokens?: unknown;
  cost?: unknown;
  [k: string]: unknown;
}

export interface SessionUsage {
  /** Effective agent id/name (session.agent wins, task.agentName fallback). */
  agent?: string;
  /** "provider/model" display string. */
  model?: string;
  /** Elapsed wall time in ms (session created → updated, fallback first→last message). */
  elapsedMs?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Total cost in USD when the server reports it. */
  cost?: number;
  messageCount: number;
}

// Raw v2 message item from GET /api/session/{id}/message:
// { data: SessionMessage[], cursor } where items carry info + parts.
export interface V2SessionMessage {
  info?: { id?: string; role?: string; text?: string; [k: string]: unknown };
  parts?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}
