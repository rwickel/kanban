// Option B store: HTTP client over /api/kanban (SQLite via server/kanban.py).
// Same function names as the old localStorage store so callers barely change.
// localStorage is kept only as a fallback cache when the dev server is down,
// plus the active-project pointer.
//
// Clone model: id=uuid, status=backlog|running|done|blocked, projectId=uuid.
import { Task, Project, TaskStatus, TaskPriority } from '../types';
import { v4 as uuidv4 } from 'uuid';

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error || `kanban API ${res.status} on ${path}`);
  }
  return res.json() as Promise<T>;
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

export async function createProject(name: string, path: string, description: string): Promise<Project> {
  // Preserve id client-side so UI can route immediately.
  // path may be a folder name ("Bridge-Server") or absolute path inside the root.
  const body: Record<string, unknown> = { id: uuidv4(), name, description };
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) body.path = path;
  else body.folder = path;
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

export async function createTask(
  projectId: string,
  title: string,
  description: string,
  priority: TaskPriority,
  agentId?: string,
  agentName?: string,
  sessionId?: string,
  modelId?: string,
  modelProviderID?: string
): Promise<Task> {
  const task = await api<Task>('/api/kanban/tasks', {
    method: 'POST',
    body: JSON.stringify({
      id: uuidv4(), projectId, title, description,
      status: 'backlog', priority,
      agentId, agentName, sessionId, modelId, modelProviderID,
    }),
  });
  mergeTaskCache(task);
  return task;
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
  const task = await api<Task>(`/api/kanban/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  mergeTaskCache(task);
  return task;
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
