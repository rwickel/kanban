// Option B store: HTTP client over /api/kanban (SQLite via server/kanban.py).
// Same function names as the old localStorage store so callers barely change.
// localStorage is kept only as a fallback cache when the dev server is down,
// plus the active-project pointer.
//
// Clone model: id=uuid, status=backlog|running|done|blocked, projectId=uuid.
import { Task, Project, TaskStatus, TaskPriority } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { enqueue, listOps, removeOp, isNetworkError, QueuedOfflineError } from './offlineQueue';
import { normalizeAllowedModels } from './modelResolution';
import { validateBlockedBy, normalizeBlockedBy } from './dependencies';

const LS_TASKS = 'kanban_tasks';
const LS_PROJECTS = 'kanban_projects';
const ACTIVE_PROJECT_KEY = 'kanban_active_project';

function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err?.error || `kanban API ${res.status} on ${path}`);
    }
    markServerUp();
    return res.json() as Promise<T>;
  } catch (e) {
    // Network error or abort → server likely down. Track for backoff.
    if (e instanceof TypeError || (e as Error)?.name === 'AbortError') markServerDown();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---- server health + poll backoff (stops console spam when Vite is down) ----
let consecutiveFailures = 0;
function markServerUp(): void {
  consecutiveFailures = 0;
}
function markServerDown(): void {
  consecutiveFailures++;
}
/** True after 2+ consecutive network failures. Resets on next success. */
export function isServerDown(): boolean {
  return consecutiveFailures >= 2;
}
/** Poll delay: 5s healthy, doubling per failure up to 60s. */
export function pollDelayMs(baseMs = 5000, maxMs = 60000): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** (consecutiveFailures - 1), maxMs);
}

// ---- cache helpers (offline fallback only) ----
function cacheTasks(tasks: Task[]): void {
  lsSet(LS_TASKS, tasks);
}
function mergeTaskCache(task: Task): void {
  const all = lsGet<Task[]>(LS_TASKS, []);
  const i = all.findIndex((t) => t.id === task.id);
  if (i === -1) all.push(task);
  else all[i] = task;
  cacheTasks(all);
}
function cacheProjects(projects: Project[]): void {
  lsSet(LS_PROJECTS, projects);
}

// ---- projects ----
export async function getProjects(): Promise<Project[]> {
  try {
    const projects = await api<Project[]>('/api/kanban/projects');
    cacheProjects(projects);
    return projects;
  } catch {
    return lsGet<Project[]>(LS_PROJECTS, []);
  }
}

export async function createProject(name: string, path: string, description: string, extra?: {
  gitUrl?: string; gitBranch?: string; mkdir?: boolean; allowedModels?: string[];
}): Promise<Project> {
  // Preserve id client-side so UI can route immediately.
  // path may be a folder name ("Bridge-Server") or absolute path inside the root.
  const body: Record<string, unknown> = { id: uuidv4(), name, description };
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) body.path = path;
  else body.folder = path;
  if (extra?.gitUrl !== undefined) body.gitUrl = extra.gitUrl;
  if (extra?.gitBranch !== undefined) body.gitBranch = extra.gitBranch;
  if (extra?.mkdir !== undefined) body.noMkdir = !extra.mkdir;
  // Allowed models — [] is meaningful (no restriction), so send it as-is.
  if (extra?.allowedModels !== undefined) body.allowedModels = extra.allowedModels;
  const project = await api<Project>('/api/kanban/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const cached = lsGet<Project[]>(LS_PROJECTS, []);
  cached.push(project);
  cacheProjects(cached);
  return project;
}

export async function updateProject(id: string, updates: Partial<Project>): Promise<Project | null> {
  try {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.path !== undefined) {
      // Folder name → server joins ROOT + name; absolute → server validates inside ROOT.
      if (/^[a-zA-Z]:[\\/]/.test(updates.path) || updates.path.startsWith('\\\\') || updates.path.startsWith('/')) body.path = updates.path;
      else body.folder = updates.path;
    }
    if (updates.folder !== undefined) body.folder = updates.folder;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.gitUrl !== undefined) body.gitUrl = updates.gitUrl;
    if (updates.gitBranch !== undefined) body.gitBranch = updates.gitBranch;
    if (updates.agentIds !== undefined) body.agentIds = updates.agentIds;
    // Allowed models — [] clears the restriction; undefined leaves it untouched.
    if (updates.allowedModels !== undefined) body.allowedModels = normalizeAllowedModels(updates.allowedModels);
    const updated = await api<Project>(`/api/kanban/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    // Refresh the offline cache with the server row.
    const cached = lsGet<Project[]>(LS_PROJECTS, []);
    const i = cached.findIndex((p) => p.id === id);
    if (i === -1) cached.push(updated);
    else cached[i] = updated;
    cacheProjects(cached);
    return updated;
  } catch {
    // Offline fallback: patch the cache only.
    const cached = lsGet<Project[]>(LS_PROJECTS, []);
    const i = cached.findIndex((p) => p.id === id);
    if (i === -1) return null;
    cached[i] = { ...cached[i], ...updates };
    cacheProjects(cached);
    return cached[i];
  }
}

export async function deleteProject(id: string): Promise<void> {
  // Server-side delete (project + its tasks in SQLite). Cache mirrors it.
  try {
    await api<{ ok: boolean }>(`/api/kanban/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // Offline fallback: delete tasks one by one, drop cache row.
    const tasks = await getTasks();
    for (const t of tasks.filter((t) => t.projectId === id)) {
      try { await deleteTask(t.id); } catch { /* keep going */ }
    }
  }
  cacheProjects(lsGet<Project[]>(LS_PROJECTS, []).filter((p) => p.id !== id));
  if (getActiveProjectIdSync() === id) {
    const rest = lsGet<Project[]>(LS_PROJECTS, []);
    setActiveProjectId(rest.length > 0 ? rest[0].id : null);
  }
}

// ---- tasks ----
/** Fetch a single task by id (server truth; throws on network/404). */
export async function getTask(id: string): Promise<Task> {
  return api<Task>(`/api/kanban/tasks/${encodeURIComponent(id)}`);
}

export async function getTasks(projectId?: string): Promise<Task[]> {
  try {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const tasks = await api<Task[]>(`/api/kanban/tasks${qs}`);
    if (projectId) {
      const others = lsGet<Task[]>(LS_TASKS, []).filter((t) => t.projectId !== projectId);
      cacheTasks([...others, ...tasks]);
    } else {
      cacheTasks(tasks);
    }
    return tasks;
  } catch {
    const all = lsGet<Task[]>(LS_TASKS, []);
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }
}

/** Raw POST without queueing — replay uses this so a failed replay breaks instead of re-queuing. */
async function postTaskRaw(body: Record<string, unknown>): Promise<Task> {
  const task = await api<Task>('/api/kanban/tasks', { method: 'POST', body: JSON.stringify(body) });
  mergeTaskCache(task);
  return task;
}

/** Raw PATCH without queueing. Strips the client-only pendingSync flag. */
async function patchTaskRaw(id: string, updates: Record<string, unknown>): Promise<Task> {
  const { pendingSync: _drop, ...clean } = updates;
  void _drop;
  const task = await api<Task>(`/api/kanban/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(clean),
  });
  mergeTaskCache(task);
  return task;
}

function sanitizeUpdates(updates: Partial<Task>): Record<string, unknown> {
  const { pendingSync: _drop, ...rest } = updates as Record<string, unknown>;
  void _drop;
  return rest;
}

export async function createTask(
  projectId: string,
  title: string,
  description: string,
  priority: TaskPriority,
  agentId?: string,
  agentName?: string,
  sessionId?: string,
  modelId?: string,
  modelProviderID?: string,
  result?: string,
  resultContext?: string,
  clientId?: string,
  acceptanceCriteria?: string,
  blockedByTaskIds?: string[]
  ,kind?: Task['kind'], cycleIntervalSec?: number
): Promise<Task> {
  // Client-generated id: offline replays reuse it, so a retried POST
  // either creates the row or fails "already exists" (safe to skip).
  const id = clientId ?? uuidv4();
  const blockedBy = validateBlockedBy(id, blockedByTaskIds ?? []);
  const payload: Record<string, unknown> = {
    id, projectId, title, description,
    status: 'backlog', priority,
    agentId, agentName, sessionId, modelId, modelProviderID,
    result, resultContext, acceptanceCriteria,
    blockedByTaskIds: blockedBy,
    kind, cycleIntervalSec,
  };
  try {
    return await postTaskRaw(payload);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    enqueue({
      kind: 'create', clientId: id, projectId, title, description, priority,
      acceptanceCriteria, blockedByTaskIds: blockedBy,
      agentId, agentName, sessionId, modelId, modelProviderID,
      taskKind: kind, cycleIntervalSec,
    });
    const now = new Date().toISOString();
    mergeTaskCache({
      id, projectId, title, description, status: 'backlog', priority,
      agentId, agentName, sessionId, modelId, modelProviderID,
      acceptanceCriteria, blockedByTaskIds: blockedBy, pendingSync: true, createdAt: now, updatedAt: now,
    });
    throw new QueuedOfflineError('Offline — task queued, syncs on reconnect.', id);
  }
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
  let clean = sanitizeUpdates(updates);
  // Dependency writes get the same guards as the server (self/cycle) up front.
  if (clean.blockedByTaskIds !== undefined) {
    const known = lsGet<Task[]>(LS_TASKS, []);
    clean = { ...clean, blockedByTaskIds: validateBlockedBy(id, clean.blockedByTaskIds, known) };
  }
  try {
    return await patchTaskRaw(id, clean);
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    enqueue({ kind: 'update', id, updates: clean });
    const all = lsGet<Task[]>(LS_TASKS, []);
    const i = all.findIndex((t) => t.id === id);
    if (i !== -1) {
      all[i] = { ...all[i], ...clean, pendingSync: true } as Task;
      cacheTasks(all);
    }
    throw new QueuedOfflineError('Offline — update queued, syncs on reconnect.', id);
  }
}

/** Replay queued writes FIFO. Stops at the first network error; drops ops the server already has. */
let replayingNow = false;
export async function replayOfflineQueue(): Promise<{ synced: number; remaining: number }> {
  if (replayingNow) return { synced: 0, remaining: listOps().length };
  replayingNow = true;
  try {
    let synced = 0;
    for (const op of listOps()) {
      try {
        if (op.kind === 'create') {
          await postTaskRaw({
            id: op.clientId, projectId: op.projectId, title: op.title,
            description: op.description, status: 'backlog', priority: op.priority,
            agentId: op.agentId, agentName: op.agentName, sessionId: op.sessionId,
             modelId: op.modelId, modelProviderID: op.modelProviderID,
             kind: op.taskKind, cycleIntervalSec: op.cycleIntervalSec,
             acceptanceCriteria: op.acceptanceCriteria,
             blockedByTaskIds: op.blockedByTaskIds ?? [],
          });
        } else {
          await patchTaskRaw(op.id, op.updates);
        }
        removeOp(op.qid);
        synced++;
      } catch (e) {
        if (isNetworkError(e)) break;
        const msg = String((e as Error)?.message ?? e);
        // Already replayed, or the task is gone — drop instead of blocking the queue.
        if (/already exists|not found|404/i.test(msg)) {
          removeOp(op.qid);
          synced++;
          continue;
        }
        break;
      }
    }
    return { synced, remaining: listOps().length };
  } finally {
    replayingNow = false;
  }
}

export async function deleteTask(id: string): Promise<void> {
  await api<{ ok: boolean }>(`/api/kanban/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  cacheTasks(lsGet<Task[]>(LS_TASKS, []).filter((t) => t.id !== id));
}

export async function moveTask(id: string, newStatus: TaskStatus): Promise<Task | null> {
  return updateTask(id, { status: newStatus });
}

export async function getTasksByProject(projectId: string): Promise<Task[]> {
  return getTasks(projectId);
}

export async function getTasksByStatus(projectId: string, status: TaskStatus): Promise<Task[]> {
  return (await getTasks(projectId)).filter((t) => t.status === status);
}

// ---- task dependencies (blockedByTaskIds) ----
export interface TaskDependencies {
  id: string;
  status: TaskStatus;
  blockedByTaskIds: string[];
  predecessors: Array<{ id: string; exists: boolean; status: TaskStatus | null; title: string | null; done: boolean }>;
  dependents: string[];
  ready: boolean;
}

/** Read one task's dependency relations from the server. */
export async function getTaskDependencies(taskId: string): Promise<TaskDependencies> {
  return api<TaskDependencies>(`/api/kanban/tasks/${encodeURIComponent(taskId)}/dependencies`);
}

/**
 * Replace the full predecessor list (empty array clears).
 * Server re-validates existence/self/cycle; client guards catch the obvious
 * cases before the round trip. Queues like any other update when offline.
 */
export async function setTaskBlockedBy(taskId: string, blockedByTaskIds: string[]): Promise<Task | null> {
  return updateTask(taskId, { blockedByTaskIds });
}

/** Add one predecessor (read-modify-write against the server truth). */
export async function addTaskBlockedBy(taskId: string, dependsOnId: string): Promise<Task | null> {
  if (dependsOnId === taskId) throw new Error(`A task cannot be blocked by itself: ${taskId}`);
  const current = await getTask(taskId);
  const next = normalizeBlockedBy([...(current.blockedByTaskIds ?? []), dependsOnId]);
  return updateTask(taskId, { blockedByTaskIds: next });
}

/** Remove one predecessor (no-op when absent). */
export async function removeTaskBlockedBy(taskId: string, dependsOnId: string): Promise<Task | null> {
  const current = await getTask(taskId);
  const next = normalizeBlockedBy((current.blockedByTaskIds ?? []).filter((id) => id !== dependsOnId));
  return updateTask(taskId, { blockedByTaskIds: next });
}

// ---- message_to: follow-up in the SAME session (no new task) ----
export interface MessageToResult {
  sessionId: string;
  taskId: string | null;
  resultText: string;
  resultTruncated: boolean;
  messageId?: string | null;
  waited?: boolean;
}

export async function messageToSession(opts: {
  sessionId?: string;
  taskId?: string;
  text: string;
  timeoutSec?: number;
  pollMs?: number;
}): Promise<MessageToResult> {
  return api<MessageToResult>('/api/kanban/message_to', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

// ---- active project pointer (still local; per-browser UI state) ----
export function getActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}
function getActiveProjectIdSync(): string | null {
  return getActiveProjectId();
}
export function setActiveProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* ignore */ }
}

// ---- roots / folders / git (KANBAN_PROJECTS_ROOT) ----
export async function getRoots(): Promise<{ root: string; folders: string[] }> {
  const r = await api<{ root: string; folders: string[] }>('/api/kanban/roots');
  return r;
}

export async function getFolderGit(folder: string): Promise<{
  folder: string; isRepo: boolean; branch?: string | null;
  dirty?: boolean; remote?: string | null; branches?: string[];
} | null> {
  try {
    return await api(`/api/kanban/folders/${encodeURIComponent(folder)}/git`);
  } catch {
    return null;
  }
}

export async function checkProjectBranch(projectId: string): Promise<{
  ok: boolean; current?: string | null; pinned: string; skipped?: string;
} | null> {
  try {
    return await api(`/api/kanban/projects/${encodeURIComponent(projectId)}/git-check`);
  } catch {
    return null;
  }
}

export async function cloneRepo(url: string, folder: string, branch?: string): Promise<unknown> {
  return api('/api/kanban/clone', {
    method: 'POST',
    body: JSON.stringify({ url, folder, branch: branch || 'main' }),
  });
}

/** Shared save path: clone-then-create on new projects, update otherwise. Desktop + mobile. */
export async function saveProject(
  data: { name: string; folder: string; description: string; gitUrl?: string; gitBranch?: string; mkdir?: boolean; allowedModels?: string[] },
  existingId?: string | null,
): Promise<Project | null> {
  const folder = data.folder.trim();
  // Clone into the new folder first (server does git clone).
  if (data.gitUrl && data.mkdir && folder) {
    await cloneRepo(data.gitUrl, folder, data.gitBranch);
  }
  const payload: Partial<Project> = {
    name: data.name,
    folder,
    description: data.description,
    gitUrl: data.gitUrl,
    gitBranch: data.gitBranch,
  };
  if (data.allowedModels !== undefined) payload.allowedModels = normalizeAllowedModels(data.allowedModels);
  if (existingId) {
    return updateProject(existingId, payload);
  }
  const created = await createProject(data.name, folder, data.description, {
    gitUrl: data.gitUrl,
    gitBranch: data.gitBranch,
    mkdir: data.mkdir,
    allowedModels: data.allowedModels !== undefined ? normalizeAllowedModels(data.allowedModels) : undefined,
  });
  // createProject stores the link; patch again if server dropped git fields.
  if ((data.gitUrl || data.gitBranch) && (!created.gitUrl || !created.gitBranch)) {
    const patched = await updateProject(created.id, { gitUrl: data.gitUrl, gitBranch: data.gitBranch });
    return patched ?? created;
  }
  return created;
}

// ---- one-shot migration: push existing localStorage rows into SQLite ----
export async function migrateLocalStorageToServer(): Promise<{ projects: number; tasks: number }> {
  const lsProjects = lsGet<Project[]>(LS_PROJECTS, []);
  const lsTasks = lsGet<Task[]>(LS_TASKS, []);
  let projects = 0;
  let tasks = 0;
  for (const p of lsProjects) {
    try {
      await api<Project>('/api/kanban/projects', {
        method: 'POST',
        body: JSON.stringify({ id: p.id, name: p.name, path: p.path, description: p.description }),
      });
      projects++;
    } catch { /* already there / server down */ }
  }
  for (const t of lsTasks) {
    try {
      await api<Task>('/api/kanban/tasks', {
        method: 'POST',
        body: JSON.stringify({
          id: t.id, projectId: t.projectId, title: t.title,
          description: t.description, status: t.status, priority: t.priority,
          agentId: t.agentId, agentName: t.agentName, sessionId: t.sessionId,
          modelId: t.modelId, modelProviderID: t.modelProviderID,
        }),
      });
      tasks++;
    } catch { /* already there / server down */ }
  }
  return { projects, tasks };
}
