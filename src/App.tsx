import { useState, useEffect, useCallback } from 'react';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  Plus,
  FolderKanban,
  Users,
  Settings,
  Trash2,
  ChevronDown,
  LayoutGrid,
  Wifi,
  WifiOff,
  Server,
  Moon,
  Sun,
  Search,
} from 'lucide-react';
import { useTheme } from './hooks/useTheme';
import { Task, TaskStatus, TaskPriority, Project, Agent, OpenCodeAgentInfo } from './types';
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
} from './store/kanban';
import { fetchAgents, createSession, sendPrompt, getServerInfo } from './api/opencode';
import { getServerConfig, getTaskModelPref } from './store/serverConfig';
import KanbanColumn, { columnIcons } from './components/KanbanColumn';
import TaskModal from './components/TaskModal';
import SessionChatWindow from './components/SessionChatWindow';
import ProjectModal from './components/ProjectModal';
import AgentTeamModal from './components/AgentTeamModal';
import ServerConfigModal from './components/ServerConfigModal';
import TaskCard from './components/TaskCard';

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'backlog', title: 'Backlog' },
  { status: 'running', title: 'In Progress' },
  { status: 'done', title: 'Complete' },
  { status: 'blocked', title: 'Blocked' },
];

export default function App() {
  // State
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<TaskStatus, Task[]>>({
    backlog: [],
    running: [],
    done: [],
    blocked: [],
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Modal states
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showAgentTeamModal, setShowAgentTeamModal] = useState(false);
  const [showServerModal, setShowServerModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  // Drag state
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  // Chat window state
  const [chatTask, setChatTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Load data — Option B: SQLite via /api/kanban (async).
  const loadData = useCallback(async () => {
    // First run: push any legacy localStorage rows into the shared DB.
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
      setTasks({
        backlog: all.filter((t) => t.status === 'backlog'),
        running: all.filter((t) => t.status === 'running'),
        done: all.filter((t) => t.status === 'done'),
        blocked: all.filter((t) => t.status === 'blocked'),
      });
    } else {
      setTasks({ backlog: [], running: [], done: [], blocked: [] });
    }
  }, []);

  // Load agents from OpenCode API
  const loadAgents = useCallback(async () => {
    try {
      const agentData: OpenCodeAgentInfo[] = await fetchAgents();
      if (agentData.length > 0) {
        setAgents(agentData.map(a => ({ id: a.id, name: a.name, description: a.description, color: a.color })));
        setIsConnected(true);
      } else {
        // Demo agents
        setAgents([
          { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#8b5cf6' },
          { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
          { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
          { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
          { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
        ]);
        setIsConnected(false);
        // No agents + no saved password → prompt to configure the server
        if (!getServerConfig().password) setShowServerModal(true);
      }
    } catch {
      setAgents([
        { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#8b5cf6' },
        { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
        { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
        { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
        { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
      ]);
      setIsConnected(false);
    }
  }, []);

  const handleServerConnected = useCallback(() => {
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    loadData();
    loadAgents();

    // Check server connection
    getServerInfo().then(info => {
      if (info) setIsConnected(true);
    });

    // Option B: MCP writes straight to SQLite — just refresh from the store.
    // 5s covers agent-side create/move/update without hammering the CLI.
    const refreshTimer = setInterval(() => {
      loadData().catch(() => { /* server down — next tick retries */ });
    }, 5000);
    return () => clearInterval(refreshTimer);
  }, [loadData, loadAgents]);

  // Active project
  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  // Get available agents for current project.
  // If the project has no team configured yet, fall back to all agents
  // so the New Task modal still offers an agent picker.
  const availableAgents = activeProject
    ? (activeProject.agentIds.length > 0
        ? agents.filter(a => activeProject.agentIds.includes(a.id))
        : agents)
    : [];

  // Handlers
  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as Task;
    if (task) setActiveTask(task);
  };

  // Optimistic helpers: update the board instantly, reconcile with server after.
  const moveTaskInState = (id: string, newStatus: TaskStatus) => {
    setTasks((prev) => {
      let found: Task | null = null;
      const next = { ...prev };
      for (const key of Object.keys(next) as TaskStatus[]) {
        const idx = next[key].findIndex((t) => t.id === id);
        if (idx !== -1) {
          const [t] = next[key].splice(idx, 1);
          found = { ...t, status: newStatus };
          next[key] = [...next[key]];
        }
      }
      if (!found) return prev;
      return { ...next, [newStatus]: [...next[newStatus], found] };
    });
  };
  const upsertTaskInState = (task: Task) => {
    setTasks((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as TaskStatus[]) {
        next[key] = next[key].filter((t) => t.id !== task.id);
      }
      return { ...next, [task.status]: [...next[task.status], task] };
    });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const task = active.data.current?.task as Task;
    const newStatus = over.data.current?.status as TaskStatus;

    if (task && newStatus && task.status !== newStatus) {
      // 1. Move instantly in UI, flag startup so the card shows progress.
      if (newStatus === 'running') {
        upsertTaskInState({ ...task, status: 'running', startupPhase: 'creating-session', startupError: undefined });
      } else {
        moveTaskInState(task.id, newStatus);
      }
      try {
        const movedTask = await moveTask(task.id, newStatus);

        // If moving to running, wire task execution to the agent.
        if (newStatus === 'running') {
          startTaskExecution(movedTask ?? { ...task, status: newStatus });
        }
      } catch (e) {
        console.error('move failed, reverting', e);
        moveTaskInState(task.id, task.status);
      } finally {
        // 2. Reconcile in background (don't block the drag animation).
        loadData().catch(() => {});
      }
    }
  };

  const buildTaskPrompt = (task: Task): string => {
    const title = task.title?.trim() || 'Untitled task';
    const desc = task.description?.trim() || '(no description provided)';
    const prio = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium';
    const project = projects.find((p) => p.id === task.projectId);
    const projectName = project?.name?.trim();
    const projectPath = project?.path?.trim();
    const headerLines = [
      'You are now executing this task autonomously. Complete it end-to-end — read the project, plan if needed, make the changes, and leave it in a working state. Ask the user only if blocked.',
      projectName ? `Project: ${projectName}${projectPath ? ` (${projectPath})` : ''}` : undefined,
      `Priority: ${prio}`,
      `Task id: ${task.id}`,
      `Project id: ${task.projectId}`,
    ].filter(Boolean).join('\n');
    const footer =
      `\n---\nWhen you are finished, use the kanban MCP tools (shared SQLite store):\n` +
      `  Call kanban_update_status with { taskId: "${task.id}", status: "done" } when complete, or "blocked" if stuck.\n` +
      `  To break off follow-up work, call kanban_create_task with { projectId: "${task.projectId}", title, description, priority }.\n` +
      `  To list/search work, call kanban_list_tasks with { projectId: "${task.projectId}" }.\n` +
      `Do the status update as the last step — after all code changes are complete. The board refreshes from the store automatically.`;
    return `${headerLines}\n\nTask: ${title}\n\nDescription: ${desc}${footer}`;
  };

  const resolveAgentForTask = (task: Task): { id?: string; name?: string } => {
    if (task.agentId) {
      const found = agents.find((a) => a.id === task.agentId);
      return { id: task.agentId, name: task.agentName ?? found?.name };
    }
    // No agent on task — fall back to project team, then any available agent
    const project = projects.find((p) => p.id === task.projectId);
    const teamIds = project?.agentIds ?? [];
    const fallback =
      agents.find((a) => teamIds.includes(a.id)) ??
      (teamIds.length === 0 ? agents[0] : undefined) ??
      agents[0];
    if (fallback) return { id: fallback.id, name: fallback.name };
    return {};
  };

  const startTaskExecution = async (task: Task) => {
    const fail = async (msg: string, taskId: string) => {
      await updateTask(taskId, { startupPhase: 'error', startupError: msg } as unknown as Partial<Task>).catch(() => {});
      upsertTaskInState({ ...task, startupPhase: 'error', startupError: msg, status: 'running' as const } as Task);
      setChatTask((cur) => (cur?.id === task.id ? ({ ...cur, startupPhase: 'error', startupError: msg } as Task) : cur));
      console.error(msg);
    };

    const resolved = resolveAgentForTask(task);
    // Persist resolved agent so TaskCard/chat have it even if user never assigned one
    if (resolved.id && !task.agentId) {
      task = { ...task, agentId: resolved.id, agentName: resolved.name };
      await updateTask(task.id, { agentId: resolved.id, agentName: resolved.name } as unknown as Partial<Task>).catch(() => {});
      upsertTaskInState(task);
    }

    const project = projects.find((p) => p.id === task.projectId);
    const directory = project?.path?.trim() || undefined;

    // Pinned branch: warn (not block) if the checkout differs from project.gitBranch.
    // Never auto-switches — that would nuke WIP when parallel tasks run.
    if (project?.id) {
      try {
        const { checkProjectBranch } = await import('./store/kanban');
        const bc = await checkProjectBranch(project.id);
        if (bc && !bc.ok && !bc.skipped) {
          const go = confirm(
            `Branch mismatch in ${project.folder || project.name}:\ncheckout is "${bc.current}", pinned is "${bc.pinned}".\n\nStart the session anyway? (OK = continue, Cancel = stop)`
          );
          if (!go) {
            moveTaskInState(task.id, task.status === 'running' ? 'backlog' : task.status);
            await loadData().catch(() => {});
            return;
          }
        }
      } catch { /* offline — skip branch check */ }
    }

    // Model: task-level pick → saved default → omit (server default).
    // OpenAPI Model.Ref is { providerID, id } — NOT { providerID, modelID }.
    const pref = getTaskModelPref();
    const raw =
      task.modelProviderID && task.modelId
        ? { providerID: task.modelProviderID, modelID: task.modelId }
        : pref
          ? pref
          : undefined;
    const model = raw ? { providerID: raw.providerID, id: raw.modelID } : undefined;

    // Reuse existing session if the task already has one, otherwise create it.
    let sessionId = task.sessionId;
    if (!sessionId) {
      // Show progress on the card + open chat right away so the user sees "creating session…" instead of empty.
      upsertTaskInState({ ...task, startupPhase: 'creating-session', startupError: undefined } as Task);
      setChatTask({ ...task, startupPhase: 'creating-session', startupError: undefined } as Task);
      const res = await createSession({ title: task.title, agent: resolved.id ?? resolved.name, model, directory });
      const session = res.session;
      if (!session?.id) {
        const msg = [
          res.error ?? 'Failed to create session — no id returned.',
          !isConnected ? 'Server is offline (DEMO mode). Open Server settings, Save & test the connection.' : undefined,
        ].filter(Boolean).join(' ');
        await fail(msg, task.id);
        await loadData().catch(() => {});
        return;
      }
      sessionId = session.id;
      // Pin the real server-assigned session id to the task
      task = { ...task, sessionId: session.id };
      await updateTask(task.id, { sessionId: session.id, agentId: resolved.id, agentName: resolved.name, startupPhase: 'sending-prompt' } as unknown as Partial<Task>).catch(() => {});
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt' } as Task);
      setChatTask({ ...task, startupPhase: 'sending-prompt' } as Task);
    } else {
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt', startupError: undefined } as Task);
      setChatTask({ ...task, startupPhase: 'sending-prompt', startupError: undefined } as Task);
    }

    // Execute the task: title + description go out as the prompt message
    // on EVERY transition to running — including re-drops of an existing session.
    const prompt = buildTaskPrompt(task);
    console.log('startTaskExecution: sending prompt for task', task.id, '→ session', sessionId);
    const sent = await sendPrompt(sessionId, prompt, resolved.id);
    if (!sent.ok) {
      await fail(`Failed to send prompt: ${sent.error ?? 'unknown error'}`, task.id);
      await loadData().catch(() => {});
      return;
    }

    await updateTask(task.id, { startupPhase: 'ready' } as unknown as Partial<Task>).catch(() => {});
    upsertTaskInState({ ...task, startupPhase: 'ready', startupError: undefined, sessionId } as Task);
    setChatTask((cur) => (cur?.id === task.id ? ({ ...cur, startupPhase: 'ready' } as Task) : cur));
    await loadData();
    // Ensure chat points at the live session
    const fresh = { ...task, sessionId, agentId: resolved.id, agentName: resolved.name, status: 'running' as const, startupPhase: 'ready' as const };
    setChatTask(fresh);
  };

  const handleOpenChat = (task: Task) => {
    if (task.sessionId) {
      setChatTask(task);
      return;
    }
    // No session yet (e.g. creation failed, or task never went through running):
    // wire it up now so the icon has something to open.
    if (task.agentId) {
      startTaskExecution(task).then(async () => {
        const all = await getTasks(task.projectId);
        const fresh = all.find(t => t.id === task.id);
        if (fresh?.sessionId) setChatTask(fresh);
      });
    }
  };

  const handleSaveTask = async (data: {
    title: string;
    description: string;
    priority: TaskPriority;
    agentId?: string;
    agentName?: string;
    modelId?: string;
    modelProviderID?: string;
  }) => {
    if (!activeProjectId) return;

    if (editingTask) {
      // Optimistic: reflect edit instantly, persist in background.
      upsertTaskInState({ ...editingTask, ...data });
      setEditingTask(null);
      try {
        await updateTask(editingTask.id, {
          title: data.title,
          description: data.description,
          priority: data.priority,
          agentId: data.agentId,
          agentName: data.agentName,
          modelId: data.modelId,
          modelProviderID: data.modelProviderID,
        });
      } catch (e) {
        console.error('update failed', e);
      } finally {
        loadData().catch(() => {});
      }
    } else {
      // Optimistic: insert a temp card instantly, swap in server row after.
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
      setEditingTask(null);
      try {
        await createTask(
          activeProjectId,
          data.title,
          data.description,
          data.priority,
          data.agentId,
          data.agentName,
          undefined,
          data.modelId,
          data.modelProviderID
        );
      } catch (e) {
        console.error('create failed, removing temp card', e);
        setTasks((prev) => ({
          ...prev,
          backlog: prev.backlog.filter((t) => t.id !== tempId),
        }));
      } finally {
        loadData().catch(() => {});
      }
    }
  };

  const handleDeleteTask = async (id: string) => {
    await deleteTask(id);
    await loadData();
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setShowTaskModal(true);
  };

  // Deep-link / pop-out window: support both hash and path (e.g. /#session/<id> or /session/<id>)
  // Pop-out renders chat-only (no board) via the standalone flag.
  const [popoutSessionId, setPopoutSessionId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return (
      window.location.hash.match(/#session\/([\w-]+)/)?.[1] ??
      window.location.pathname.match(/\/session\/([\w-]+)/)?.[1] ??
      null
    );
  });
  useEffect(() => {
    if (!popoutSessionId) return;
    getTasks().then((all) => {
      const found = all.find((t) => t.sessionId === popoutSessionId);
      if (found) setChatTask(found);
    }).catch(() => { /* ignore */ });
  }, [popoutSessionId]);

  const handleSaveProject = async (data: { name: string; folder: string; description: string; gitUrl?: string; gitBranch?: string; mkdir?: boolean }) => {
    const targetId = editingProject?.id ?? null;
    const folder = data.folder.trim();
    // Clone into the new folder if a URL was given (server does git clone).
    if (data.gitUrl && data.mkdir && folder) {
      try {
        const { cloneRepo } = await import('./store/kanban');
        await cloneRepo(data.gitUrl, folder, data.gitBranch);
      } catch (e: unknown) {
        alert(`Clone failed: ${String((e as Error)?.message ?? e).slice(0, 400)}`);
        return;
      }
    }
    const projPayload: Partial<import('./types').Project> = {
      folder,
      description: data.description,
      name: data.name,
      gitUrl: data.gitUrl,
      gitBranch: data.gitBranch,
    };
    if (editingProject) {
      const updated = await updateProject(editingProject.id, projPayload);
      if (updated && (updated.folder ?? '') !== folder) {
        alert(`Project saved, but stored folder differs:\ntyped: ${folder}\nstored: ${updated.folder ?? updated.path}`);
      }
    } else {
      const newProject = await createProject(data.name, folder, data.description);
      // Persist git link if provided on create (createProject only knows name/folder).
      if (data.gitUrl || data.gitBranch) {
        await updateProject(newProject.id, { gitUrl: data.gitUrl, gitBranch: data.gitBranch });
      }
      setActiveProjectId(newProject.id);
    }
    setEditingProject(null);
    await loadData();
    try {
      const projs = await getProjects();
      const check = targetId ? projs.find((p) => p.id === targetId) : projs[projs.length - 1];
      if (check && (check.folder ?? '') !== folder) {
        alert(`Warning: folder not stored correctly.\nexpected: ${folder}\nstored:    ${check.folder ?? check.path}`);
      }
    } catch { /* offline */ }
  };

  const handleDeleteProject = async (id: string) => {
    if (confirm('Delete this project and all its tasks?')) {
      await deleteProject(id);
      await loadData();
    }
  };

  const handleSwitchProject = async (id: string) => {
    setActiveProjectId(id);
    setActiveProjectIdState(id);
    setShowProjectDropdown(false);

    const all = await getTasks(id);
    setTasks({
      backlog: all.filter((t) => t.status === 'backlog'),
      running: all.filter((t) => t.status === 'running'),
      done: all.filter((t) => t.status === 'done'),
      blocked: all.filter((t) => t.status === 'blocked'),
    });
  };

  const handleSaveAgentTeam = async (agentIds: string[]) => {
    if (activeProjectId) {
      await updateProject(activeProjectId, { agentIds });
      await loadData();
    }
  };

  const handleAddTask = () => {
    setEditingTask(null);
    setShowTaskModal(true);
  };

  // Keyboard-first: N = new task, Esc closes dropdown
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handleAddTask();
        return;
      }
      if (typing) {
        if (e.key === 'Escape') (el as HTMLElement).blur();
        return;
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleAddTask();
      } else if (e.key === 'Escape') {
        setShowProjectDropdown(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeProjectId]);

  const { theme, toggle } = useTheme();

  // Pop-out windows (window.open with #session/…) render chat-only — not the full board.
  if (popoutSessionId) {
    return (
      <div className="app-shell">
        <SessionChatWindow
          task={chatTask}
          standalone
          onClose={() => {
            if (window.opener) window.close();
            else {
              history.replaceState(null, '', window.location.pathname);
              setPopoutSessionId(null);
              setChatTask(null);
            }
          }}
        />
        {!chatTask && (
          <div className="flex-1 flex items-center justify-center p-8 muted text-[13px] text-center">
            Loading session {popoutSessionId}…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="topbar">
        <div className="max-w-full mx-auto px-4 py-2">
          <div className="flex items-center justify-between gap-3">
            {/* Left: Logo & Title */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 flex items-center justify-center" style={{ background: 'var(--accent)', borderRadius: 6 }}>
                  <LayoutGrid className="w-4 h-4" style={{ color: 'var(--accent-text)' }} strokeWidth={1.75} />
                </div>
                <div>
                  <h1 className="text-[15px] font-semibold t-strong leading-tight">Kanban Board</h1>
                  <p className="text-[11px] muted mono -mt-px">OPENCODE · V2</p>
                </div>
              </div>

              {/* Connection status */}
              <button
                onClick={() => setShowServerModal(true)}
                title="Configure server connection"
                className={`pill ${isConnected ? 'p-green' : 'p-amber'}`}
              >
                <span className="dot" style={{ background: isConnected ? 'var(--emerald)' : 'var(--amber)' }} />
                {isConnected ? <Wifi className="w-3 h-3" strokeWidth={1.75} /> : <WifiOff className="w-3 h-3" strokeWidth={1.75} />}
                <span>{isConnected ? 'CONNECTED' : 'DEMO'}</span>
              </button>
              {/* Search hint */}
              <span className="hidden md:flex items-center gap-1.5 pill p-neutral">
                <Search className="w-3 h-3" strokeWidth={1.75} />
                <span>Search</span>
                <span className="kbd">⌘K</span>
              </span>
            </div>

            {/* Center: Project Selector */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                  className="btn flex items-center gap-2 px-4 py-2 text-[14px]"
                >
                  <FolderKanban className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
                  <span className="font-medium t-strong">
                    {activeProject?.name || 'Select Project'}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
                </button>

                {/* Dropdown */}
                {showProjectDropdown && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowProjectDropdown(false)} />
                    <div className="absolute top-full left-0 mt-1.5 w-80 modal-card z-20 overflow-hidden animate-fadeIn">
                      <div className="p-1.5 max-h-64 overflow-y-auto">
                        {projects.length === 0 ? (
                          <p className="text-[13px] muted p-3 text-center">No projects yet</p>
                        ) : (
                          projects.map((project) => (
                            <div
                              key={project.id}
                              className="flex items-center justify-between p-2 rounded cursor-pointer hoverable"
                              style={{ border: project.id === activeProjectId ? '1px solid var(--border-strong)' : '1px solid transparent' }}
                            >
                              <button
                                onClick={() => handleSwitchProject(project.id)}
                                className="flex-1 text-left min-w-0"
                              >
                                <p className="text-[13px] font-medium t-strong truncate">{project.name}</p>
                                <p className="text-[11px] muted mono truncate">{project.path}</p>
                              </button>
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingProject(project);
                                    setShowProjectModal(true);
                                  }}
                                  className="btn p-1"
                                >
                                  <Settings className="w-3 h-3" strokeWidth={1.75} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteProject(project.id);
                                  }}
                                  className="btn p-1"
                                >
                                  <Trash2 className="w-3 h-3" strokeWidth={1.75} />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="p-1.5 border-t hairline" style={{ borderTopStyle: 'solid', borderTopWidth: 1 }}>
                        <button
                          onClick={() => {
                            setEditingProject(null);
                            setShowProjectModal(true);
                            setShowProjectDropdown(false);
                          }}
                          className="btn w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[13px] font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                          New Project
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={toggle}
                className="btn flex items-center gap-1.5 px-3 py-2 text-[13px]"
                title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              >
                {theme === 'light' ? <Moon className="w-3.5 h-3.5" strokeWidth={1.75} /> : <Sun className="w-3.5 h-3.5" strokeWidth={1.75} />}
                <span className="hidden sm:inline mono">{theme === 'light' ? 'DARK' : 'LIGHT'}</span>
              </button>
              <button
                onClick={() => setShowServerModal(true)}
                className="btn flex items-center px-2.5 py-1.5"
                title="Server connection"
              >
                <Server className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              {activeProject && (
                <>
                  <button
                    onClick={() => setShowAgentTeamModal(true)}
                    className="btn flex items-center gap-1.5 px-3 py-2 text-[13px]"
                    title="Configure agent team"
                  >
                    <Users className="w-3.5 h-3.5" strokeWidth={1.75} />
                    <span className="hidden lg:inline">Team</span>
                    {availableAgents.length > 0 && (
                      <span className="pill p-neutral">{availableAgents.length}</span>
                    )}
                  </button>
                  <button
                    onClick={handleAddTask}
                    className="btn btn-primary flex items-center gap-1.5 px-4 py-2 text-[14px] font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                    <span>New Task</span>
                    <span className="kbd" style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>N</span>
                  </button>
                </>
              )}
              {!activeProject && (
                <button
                  onClick={() => {
                    setEditingProject(null);
                    setShowProjectModal(true);
                  }}
                  className="btn btn-primary flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium"
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                  <span>New Project</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-4">
        {!activeProject ? (
          <div className="flex flex-col items-center justify-center h-[calc(100vh-120px)]">
            <div className="w-12 h-12 panel flex items-center justify-center mb-4">
              <FolderKanban className="w-5 h-5 muted" strokeWidth={1.5} />
            </div>
            <h2 className="text-lg font-semibold t-strong mb-1">Kanban Agent Board</h2>
            <p className="muted mb-4 text-center max-w-md text-[13px]">
              Create a project to get started. Manage tasks with AI agents. <span className="kbd">N</span> new task · <span className="kbd">⌘K</span> search
            </p>
            <button
              onClick={() => {
                setEditingProject(null);
                setShowProjectModal(true);
              }}
              className="btn btn-primary flex items-center gap-2 px-4 py-2 text-[13px] font-medium"
            >
              <Plus className="w-4 h-4" strokeWidth={1.75} />
              Create Your First Project
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 overflow-x-auto pb-4">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.status}
                  status={col.status}
                  title={col.title}
                  icon={columnIcons[col.status]}
                  tasks={tasks[col.status]}
                  onEditTask={handleEditTask}
                  onDeleteTask={handleDeleteTask}
                  onOpenChat={handleOpenChat}
                  onAddTask={handleAddTask}
                />
              ))}
            </div>

            <DragOverlay>
              {activeTask ? (
                <div>
                  <TaskCard
                    task={activeTask}
                    onEdit={() => {}}
                    onDelete={() => {}}
                    onOpenChat={() => {}}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {/* Modals */}
      <TaskModal
        isOpen={showTaskModal}
        onClose={() => {
          setShowTaskModal(false);
          setEditingTask(null);
        }}
        onSave={handleSaveTask}
        task={editingTask}
        availableAgents={availableAgents}
      />

      <ProjectModal
        isOpen={showProjectModal}
        onClose={() => {
          setShowProjectModal(false);
          setEditingProject(null);
        }}
        onSave={handleSaveProject}
        project={editingProject}
      />

      <AgentTeamModal
        isOpen={showAgentTeamModal}
        onClose={() => setShowAgentTeamModal(false)}
        onSave={handleSaveAgentTeam}
        selectedAgentIds={activeProject?.agentIds || []}
      />

      <ServerConfigModal
        isOpen={showServerModal}
        onClose={() => setShowServerModal(false)}
        onConnected={handleServerConnected}
      />

      {/* Session chat — in-app side panel + deep-linkable pop-out window */}
      <SessionChatWindow task={chatTask} onClose={() => setChatTask(null)} />
    </div>
  );
}
