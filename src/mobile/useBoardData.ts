import { useCallback, useEffect, useRef, useState } from 'react';
import { Task, TaskStatus, TaskPriority, Project, Agent, OpenCodeAgentInfo } from '../types';
import {
  getProjects,
  getActiveProjectId,
  setActiveProjectId,
  createProject,
  updateProject,
  deleteProject,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  migrateLocalStorageToServer,
  pollDelayMs,
} from '../store/kanban';
import { fetchAgents, createSession, sendPrompt, getServerInfo } from '../api/opencode';
import { getTaskModelPref } from '../store/serverConfig';
import { ensureAssistantSession } from '../store/assistantSession';

// Copied from App.tsx — the desktop file must not change.
// This copy keeps the same poll delay, optimistic stamps, and auto-start rule.
export function useBoardData() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<TaskStatus, Task[]>>({
    backlog: [], running: [], done: [], blocked: [],
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const optimisticRef = useRef<Record<string, { status: TaskStatus; at: number }>>({});

  const moveTaskInState = useCallback((id: string, newStatus: TaskStatus) => {
    optimisticRef.current[id] = { status: newStatus, at: Date.now() };
    setTasks((prev) => {
      let found: Task | null = null;
      const next = { ...prev } as Record<TaskStatus, Task[]>;
      for (const key of Object.keys(next) as TaskStatus[]) {
        const idx = next[key].findIndex((t) => t.id === id);
        if (idx !== -1) {
          const arr = [...next[key]];
          const [t] = arr.splice(idx, 1);
          found = { ...t, status: newStatus };
          next[key] = arr;
        }
      }
      if (!found) return prev;
      return { ...next, [newStatus]: [...next[newStatus], found] };
    });
  }, []);

  const upsertTaskInState = useCallback((task: Task) => {
    optimisticRef.current[task.id] = { status: task.status, at: Date.now() };
    setTasks((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as TaskStatus[]) {
        next[key] = next[key].filter((t) => t.id !== task.id);
      }
      return { ...next, [task.status]: [...next[task.status], task] };
    });
  }, []);

  const loadData = useCallback(async () => {
    try {
      if (!localStorage.getItem('kanban_migrated_v2')) {
        await migrateLocalStorageToServer();
        localStorage.setItem('kanban_migrated_v2', '1');
      }
    } catch { /* server down — fall back to cache */ }

    let activeId = getActiveProjectId();
    const peek = activeId;
    const [projs, all] = await Promise.all([
      getProjects(),
      peek ? getTasks(peek) : Promise.resolve([] as Task[]),
    ]);
    setProjects(projs);

    if (!activeId && projs.length > 0) {
      activeId = projs[0].id;
      setActiveProjectId(activeId);
    }
    setActiveProjectIdState(activeId);

    if (activeId) {
      const now = Date.now();
      const guarded = all.map((t) => {
        const opt = optimisticRef.current[t.id];
        if (opt && now - opt.at < 15000 && t.status !== opt.status) {
          return { ...t, status: opt.status };
        }
        if (opt && (now - opt.at >= 15000 || t.status === opt.status)) {
          delete optimisticRef.current[t.id];
        }
        return t;
      });
      setTasks({
        backlog: guarded.filter((t) => t.status === 'backlog'),
        running: guarded.filter((t) => t.status === 'running'),
        done: guarded.filter((t) => t.status === 'done'),
        blocked: guarded.filter((t) => t.status === 'blocked'),
      });
    } else {
      setTasks({ backlog: [], running: [], done: [], blocked: [] });
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const agentData: OpenCodeAgentInfo[] = await fetchAgents();
      if (agentData.length > 0) {
        setAgents(agentData.map(a => ({ id: a.id, name: a.name, description: a.description, color: a.color })));
        setIsConnected(true);
      } else {
        setAgents([
          { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#8b5cf6' },
          { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
          { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
        ]);
        setIsConnected(false);
      }
    } catch {
      setAgents([{ id: 'coder', name: 'Coder', description: 'Coding agent', color: '#8b5cf6' }]);
      setIsConnected(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadAgents();
    getServerInfo().then(info => { if (info) setIsConnected(true); });

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      loadData()
        .catch(() => { /* server down — backoff retries */ })
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, pollDelayMs());
        });
    };
    timer = setTimeout(tick, pollDelayMs());
    return () => { stopped = true; clearTimeout(timer); };
  }, [loadData, loadAgents]);

  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  const availableAgents = activeProject
    ? (activeProject.agentIds.length > 0
        ? agents.filter(a => activeProject.agentIds.includes(a.id))
        : agents)
    : [];

  const startTaskExecution = useCallback(async (task: Task) => {
    if (task.id.startsWith('temp-')) return;
    const resolved = task.agentId
      ? { id: task.agentId, name: task.agentName }
      : agents[0] ? { id: agents[0].id, name: agents[0].name } : {};
    if (resolved.id && !task.agentId) {
      task = { ...task, agentId: resolved.id, agentName: resolved.name };
      await updateTask(task.id, { agentId: resolved.id, agentName: resolved.name } as Partial<Task>).catch(() => {});
      upsertTaskInState(task);
    }
    const activeProj = projects.find((p) => p.id === task.projectId);
    const directory = activeProj?.path?.trim() || undefined;
    const pref = getTaskModelPref();
    const raw = task.modelProviderID && task.modelId
      ? { providerID: task.modelProviderID, modelID: task.modelId }
      : pref ? pref : undefined;
    const model = raw ? { providerID: raw.providerID, id: raw.modelID } : undefined;

    let sessionId = task.sessionId;
    if (!sessionId) {
      upsertTaskInState({ ...task, startupPhase: 'creating-session', startupError: undefined } as Task);
      const res = await createSession({ title: task.title, agent: resolved.id ?? resolved.name, model, directory });
      if (!res.session?.id) return;
      sessionId = res.session.id;
      task = { ...task, sessionId: res.session.id };
      await updateTask(task.id, { sessionId: res.session.id, agentId: resolved.id, agentName: resolved.name, startupPhase: 'sending-prompt' } as Partial<Task>).catch(() => {});
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt' } as Task);
    } else {
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt', startupError: undefined } as Task);
    }
    const desc = task.description?.trim() || '(no description provided)';
    const sent = await sendPrompt(sessionId, `# ${task.title}\n\n${desc}`, resolved.id);
    if (!sent.ok) {
      await updateTask(task.id, { startupPhase: 'error', startupError: sent.error } as Partial<Task>).catch(() => {});
      upsertTaskInState({ ...task, startupPhase: 'error', startupError: sent.error } as Task);
      return;
    }
    await updateTask(task.id, { startupPhase: 'ready' } as Partial<Task>).catch(() => {});
    upsertTaskInState({ ...task, startupPhase: 'ready', startupError: undefined, sessionId } as Task);
    await loadData().catch(() => {});
  }, [agents, loadData, projects, upsertTaskInState]);

  const startingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const candidates = tasks.running.filter((t) => {
      if (startingRef.current.has(t.id)) return false;
      if (['creating-session', 'sending-prompt', 'error'].includes(t.startupPhase as string)) return false;
      return !t.startupPhase;
    });
    if (candidates.length === 0) return;
    for (const t of candidates) {
      startingRef.current.add(t.id);
      startTaskExecution(t).finally(() => {
        startingRef.current.delete(t.id);
      });
    }
  }, [tasks.running, startTaskExecution]);

  useEffect(() => {
    const pid = activeProjectId;
    if (!pid) return;
    const proj = projects.find((p) => p.id === pid);
    if (!proj) return;
    void ensureAssistantSession(proj).catch((e) => console.warn('assistant session startup failed', e));
  }, [activeProjectId, projects]);

  const handleMove = useCallback(async (task: Task, newStatus: TaskStatus) => {
    if (task.status === newStatus) return;
    moveTaskInState(task.id, newStatus);
    try {
      await moveTask(task.id, newStatus);
    } catch (e) {
      console.error('move failed, reverting', e);
      moveTaskInState(task.id, task.status);
    } finally {
      loadData().catch(() => {});
    }
  }, [loadData, moveTaskInState]);

  const handleSave = useCallback(async (
    data: { title: string; description: string; priority: TaskPriority; agentId?: string; agentName?: string; modelId?: string; modelProviderID?: string; result?: string; resultContext?: string },
    editingTask?: Task | null,
  ) => {
    if (!activeProjectId) return;
    if (editingTask) {
      upsertTaskInState({ ...editingTask, ...data });
      await updateTask(editingTask.id, data).catch(() => {});
      loadData().catch(() => {});
    } else {
      const tempId = `temp-${Date.now()}`;
      const tempTask: Task = {
        id: tempId,
        projectId: activeProjectId,
        title: data.title,
        description: data.description,
        status: 'backlog',
        priority: data.priority,
        agentId: data.agentId,
        agentName: data.agentName,
        modelId: data.modelId,
        modelProviderID: data.modelProviderID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      upsertTaskInState(tempTask);
      try {
        await createTask(activeProjectId, data.title, data.description, data.priority, data.agentId, data.agentName, undefined, data.modelId, data.modelProviderID);
      } catch (e) {
        console.error('create failed, removing temp card', e);
        setTasks((prev) => ({ ...prev, backlog: prev.backlog.filter((t) => t.id !== tempId) }));
        delete optimisticRef.current[tempId];
      } finally {
        loadData().catch(() => {});
      }
    }
  }, [activeProjectId, loadData, upsertTaskInState]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await deleteTask(id);
      await loadData();
    } catch (e) {
      console.error('delete failed', e);
      await loadData().catch(() => {});
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [loadData]);

  const handleSwitchProject = useCallback(async (id: string) => {
    setActiveProjectId(id);
    setActiveProjectIdState(id);
    const all = await getTasks(id);
    setTasks({
      backlog: all.filter((t) => t.status === 'backlog'),
      running: all.filter((t) => t.status === 'running'),
      done: all.filter((t) => t.status === 'done'),
      blocked: all.filter((t) => t.status === 'blocked'),
    });
  }, []);

  const handleSaveProject = useCallback(async (
    data: { name: string; folder: string; description: string },
    editing?: Project | null,
  ): Promise<Project | null> => {
    if (editing) {
      await updateProject(editing.id, { name: data.name, folder: data.folder, description: data.description });
      await loadData();
      return null;
    }
    const np = await createProject(data.name, data.folder, data.description);
    setActiveProjectId(np.id);
    await loadData();
    return np;
  }, [loadData]);

  const handleDeleteProject = useCallback(async (id: string) => {
    await deleteProject(id);
    await loadData();
  }, [loadData]);

  return {
    projects, activeProjectId, tasks, agents, isConnected, deletingIds,
    activeProject, availableAgents,
    loadData, loadAgents, handleMove, handleSave, handleDelete,
    handleSwitchProject, handleSaveProject, handleDeleteProject,
  };
}
