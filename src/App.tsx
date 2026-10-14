import { useState, useEffect, useCallback, useRef } from 'react';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  Plus,
  FolderKanban,
  Users,
  MessageSquare,
  Settings,
  Trash2,
  ChevronDown,
  LayoutGrid,
  Wifi,
  WifiOff,
  Server,
  Moon,
  Sun,
} from 'lucide-react';
import { Theme, useTheme } from './hooks/useTheme';
import { readSpeechLang, usePreferences } from './hooks/usePreferences';
import { Task, TaskStatus, TaskPriority, Project, Agent, OpenCodeAgentInfo } from './types';
import {
  getProjects,
  getActiveProjectId,
  setActiveProjectId,
  updateProject,
  deleteProject,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  migrateLocalStorageToServer,
  isServerDown,
  pollDelayMs,
  replayOfflineQueue,
} from './store/kanban';
import { isQueuedOffline } from './store/offlineQueue';
import { useOfflineSync } from './hooks/useOfflineSync';
import OfflineBanner from './components/OfflineBanner';
import { fetchAgents, createSession, sendPrompt, getServerInfo } from './api/opencode';
import { getTaskModelPref } from './store/serverConfig';
import { ensureAssistantSession } from './store/assistantSession';
import KanbanColumn, { columnIcons } from './components/KanbanColumn';
import TaskModal from './components/TaskModal';
import SessionChatWindow from './components/SessionChatWindow';
import AssistantChatWindow from './components/AssistantChatWindow';
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

// Customizable agent style (prompts/final-message-style.md), loaded once.
// Edit the file + refresh the page to change what agents are told.
let styleGuideCache: string | null = null;
async function loadStyleGuide(): Promise<string> {
  if (styleGuideCache !== null) return styleGuideCache;
  try {
    const r = await fetch('/api/kanban/prompts/final-message-style.md');
    styleGuideCache = r.ok ? (await r.text()).trim() : '';
  } catch { styleGuideCache = ''; }
  return styleGuideCache;
}
void loadStyleGuide();

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

  // Offline banner + queued writes: browser flag, server health, replay.
  const { offline, queued, replaying, refreshSyncState, replayQueue } = useOfflineSync();

  // Chat window state
  const [chatTask, setChatTask] = useState<Task | null>(null);
  const [showAssistant, setShowAssistant] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Optimistic-move stamps: id → {status, at}. Guards against two races:
  // 1) the 5s refresh poll firing while the Python CLI write is still in
  //    flight (cold-start can take seconds) — the fetched row still carries
  //    the OLD status and would snap the card back to backlog.
  // 2) startTaskExecution's updateTask(...startupPhase) responses echoing a
  //    row whose status lags the drag target.
  // Entries expire after 15s so a genuinely failed move still reconciles.
  const optimisticRef = useRef<Record<string, { status: TaskStatus; at: number }>>({});

  // Load data — Option B: SQLite via /api/kanban (async).
  const loadData = useCallback(async () => {
    // First run: push any legacy localStorage rows into the shared DB.
    try {
      if (!localStorage.getItem('kanban_migrated_v2')) {
        await migrateLocalStorageToServer();
        localStorage.setItem('kanban_migrated_v2', '1');
      }
    } catch (e) {
      if (!isQueuedOffline(e)) console.warn('migration skipped (server down)', e);
    }
    // Reconnect: replay queued creates/updates before reading, so the board
    // reflects what the user already did offline.
    // Reads must NEVER throw: getProjects/getTasks already fall back to the
    // local cache on network failure, and loadData is called from handlers
    // whose catch blocks replaced silent failures — a poll tick must not crash
    // the board because the server went down.
    let replayErr: unknown = null;
    try {
      const { synced } = await replayOfflineQueue();
      if (synced > 0) refreshSyncState();
    } catch (e) {
      replayErr = e;
    }
    if (replayErr && !isQueuedOffline(replayErr)) console.warn('queue replay skipped (server down)', replayErr);

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
          // Server hasn't caught up with our optimistic move yet — keep
          // showing the card in the dragged-to column.
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
        // No real agents → is the server still disconnected? Only prompt
        // when /api/kanban/server has no password stored (server-side).
        try {
          const r = await fetch('/api/kanban/server');
          const j = await r.json().catch(() => ({}));
          if (!j?.hasPassword) setShowServerModal(true);
        } catch {
          setShowServerModal(true);
        }
      }
    } catch {
      setAgents([
        { id: 'coder', name: 'Coder', description: 'Coding agent', color: '#8b5cf6' },
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
      if (info) { setIsConnected(true); refreshSyncState(); }
    }).catch(() => { refreshSyncState(); });

    // Option B: agents write straight to SQLite — just refresh from the store.
    // Backoff: 5s healthy, doubling per failure up to 60s so a dead
    // server doesn't spam the console with ERR_CONNECTION_REFUSED.
    // Every tick refreshes the offline banner state (server may have recovered).
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      loadData()
        .catch((e) => { console.warn('poll skipped (server down)', e); })
        .finally(() => {
          refreshSyncState();
          if (!stopped) timer = setTimeout(tick, pollDelayMs());
        });
    };
    timer = setTimeout(tick, pollDelayMs());
    return () => { stopped = true; clearTimeout(timer); };
  }, [loadData, loadAgents, refreshSyncState]);

  // Reconnect (browser online event): flush the queue, then reload.
  // loadData replays internally too — this listener only handles the moment
  // the network returns, so queued writes don't wait for the next 5s poll.
  useEffect(() => {
    const flush = () => {
      void replayQueue().then(() => {
        loadData().catch((e) => { console.warn('reconnect refresh skipped (server down)', e); });
      });
    };
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [loadData, replayQueue]);

  const handleSyncNow = useCallback(() => {
    void (async () => {
      await replayQueue();
      await loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
      refreshSyncState();
    })();
  }, [loadData, replayQueue, refreshSyncState]);

  // Board assistant chat gets its own assistant session at startup so the
  // id is known right away (pastable in the welcome bubble, usable as
  // parentSessionId on the first delegated task). Does not reopen the panel.
  useEffect(() => {
    const pid = activeProjectId;
    if (!pid) return;
    const proj = projects.find((p) => p.id === pid);
    if (!proj) return;
    void ensureAssistantSession(proj).catch((e) => console.warn('assistant session startup failed', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

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
    // Stamp the optimistic move so stale full-refreshes (5s poll, or the
    // post-drag loadData racing the Python CLI write) can't snap the card
    // back to the old column: loadData skips any row older than this stamp.
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
  };
  const clearOptimisticStamp = (id: string) => {
    delete optimisticRef.current[id];
  };
  const upsertTaskInState = (task: Task) => {
    // Same stamp as moveTaskInState — see comment there.
    optimisticRef.current[task.id] = { status: task.status, at: Date.now() };
    setTasks((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as TaskStatus[]) {
        next[key] = next[key].filter((t) => t.id !== task.id);
      }
      return { ...next, [task.status]: [...next[task.status], task] };
    });
  };

  // Auto-start guard: task ids with execution currently in flight.
  const startingRef = useRef<Set<string>>(new Set());

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const task = active.data.current?.task as Task;
    const newStatus = over.data.current?.status as TaskStatus;

    if (task && newStatus && task.status !== newStatus) {
      // Move instantly in UI; the auto-start watcher above picks up
      // running and wires execution (single path for drag + external moves).
      moveTaskInState(task.id, newStatus);
      try {
        await moveTask(task.id, newStatus);
      } catch (e) {
        if (isQueuedOffline(e)) {
          // Server unreachable — keep the card in the new column, flag it
          // QUEUED, reconcile on the next loadData/replay.
          upsertTaskInState({ ...task, status: newStatus, pendingSync: true });
        } else {
          console.warn('move failed, reverting', e);
          moveTaskInState(task.id, task.status);
        }
      } finally {
        // 2. Reconcile in background (don't block the drag animation).
        refreshSyncState();
        loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
      }
    }
  };

  const buildTaskPrompt = (task: Task): string => {
    const styleSnippet = styleGuideCache?.trim() || '- Use Simplified Technical English (ASD-STE100) in your final message: approved simple verbs (add, remove, update, move, rename, fix, replace), one instruction per sentence, maximum 20 words per sentence, no jargon.';
    const languageNames: Record<string, string> = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch' };
    const configuredLanguage = languageNames[readSpeechLang()] ?? 'English';
    const title = task.title?.trim() || 'Untitled task';
    const desc = task.description?.trim() || '(no description provided)';
    const prio = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium';
    const project = projects.find((p) => p.id === task.projectId);
    const projectName = project?.name?.trim();
    const projectPath = project?.path?.trim();
    // Agent team context: assigned agent + project team roster + all known agents.
    const assigned = task.agentId
      ? (agents.find((a) => a.id === task.agentId) ?? { id: task.agentId, name: task.agentName ?? task.agentId })
      : undefined;
    const teamIds = project?.agentIds ?? [];
    const teamAgents = teamIds
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is Agent => Boolean(a));
    const teamLines = teamAgents.length > 0
      ? teamAgents.map((a) => `- ${a.name} (id: ${a.id})${a.description ? ` — ${a.description}` : ''}`).join('\n')
      : teamIds.length > 0
        ? teamIds.map((id) => `- (id: ${id})`).join('\n')
        : '(no project team configured — all agents available)';
    const headerLines = [
      `# ${title}`,
      '',
      `**Project:** ${projectName ? `${projectName}${projectPath ? ` (${projectPath})` : ''}` : '(unknown)'}`,
      `**Priority:** ${prio}`,
      `**Task id:** ${task.id}`,
      `**Project id:** ${task.projectId}`,
      task.sessionId ? `**Your session id:** ${task.sessionId}` : undefined,
      task.parentSessionId
        ? `**Parent session:** ${task.parentSessionId} (the session that created this task — report back there if needed)`
        : `**Parent session:** — (created directly by user/board)`,
      assigned ? `**Assigned agent:** ${assigned.name} (id: ${assigned.id})` : undefined,
      '',
      `**Team for this project:**`,
      teamLines,
      '',
      `## What to do`,
      '',
      desc,
      '',
      `## How to work`,
      '',
      `- Execute autonomously end-to-end: read the project, plan if needed, make the changes, leave it in a working state.`,
      `- Ask the user only if blocked; keep the final message concise — it becomes the stored task result automatically.`,
      `- No status update needed: the board follows your session outcome by itself (end → done, failure → blocked) and captures your last message as the result.`,
      styleSnippet,
      `- Write all chat output, task results, and summaries in ${configuredLanguage}.`,
      `- Use Simplified Technical English (ASD-STE100) principles: short sentences, simple verbs, direct statements, and specific results.`,
      `- Keep technical names, file paths, API paths, IDs, and code unchanged.`,
      '',
      `## Working with other tasks (optional)`,
      '',
      `- API base: http://localhost:3001/api (full spec: http://localhost:3001/api/kanban/docs).`,
      `- Follow-up work: POST /api/kanban/tasks { "projectId": "${task.projectId}", "title": "...", "description": "...", "priority": "medium", "parentSessionId": "${task.sessionId ?? '<your session id>'}" }.`,
      `- Delegate + WAIT for result (sync): POST /api/kanban/delegate { "projectId": "${task.projectId}", "title": "...", "description": "...", "agentId": "<teammate-id>", "parentSessionId": "${task.sessionId ?? '<your session id>'}" } → returns the finished Task.`,
      `- Follow-up in the SAME subtask session: POST /api/kanban/message_to { "sessionId": "<from delegate>", "text": "..." } (or { "taskId": "<subtask-id>", "text": "..." }) → { sessionId, resultText }.`,
      `- List work: GET /api/kanban/tasks?projectId=${task.projectId}.`,
      '',
      `## Project instructions and lessons`,
      '',
      `- Read the project-local AGENTS.md before planning when it exists.`,
      `- Add durable project instructions, decisions, conventions, commands, and lessons to AGENTS.md.`,
      `- Create AGENTS.md in the project root when the user asks to save durable guidance.`,
      `- Update existing entries instead of adding duplicates.`,
      `- Keep temporary task notes in the task description or result.`,
      `- Never store passwords, tokens, private keys, or other secrets in AGENTS.md.`,
      `- Report AGENTS.md changes in the final task result.`,
    ].filter(Boolean).join('\n');
    return headerLines;
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
    if (task.status !== 'running') return;
    // Temp optimistic cards (temp-*) are local-only until createTask resolves
    // with the server row. Never send them to the server — the watcher may
    // pick them up mid-create and PATCH would 404 + flip them to error.
    // Offline-queued cards (pendingSync) already carry their final replay id,
    // so they may proceed on reconnect.
    if (task.id.startsWith('temp-') && !task.pendingSync) return;
    // Infra self-healing: startup failures (session create, prompt send,
    // branch mismatch) auto-create a fix task in backlog so the issue is
    // tracked. Fix tasks themselves never spawn follow-ups (no recursion).
    const isFixTask = task.title.startsWith('Fix (infra):');
    const ensureFixTask = async (title: string, description: string) => {
      if (isFixTask) return;
      try {
        const existing = await getTasks(task.projectId);
        const dup = existing.some((t) =>
          (t.status === 'backlog' || t.status === 'running') &&
          t.title === title
        );
        if (dup) return;
        const fix = await createTask(task.projectId, title, description, 'high', task.agentId, task.agentName);
        upsertTaskInState(fix);
      } catch (e) {
        console.error('ensureFixTask failed', e);
      }
    };
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
            await ensureFixTask(
              `Fix (infra): branch mismatch in ${project.folder || project.name}`,
              `Branch mismatch in ${project.folder || project.name}: checkout is "${bc.current}", pinned is "${bc.pinned}".\nOrigin task: ${task.title} (${task.id}).\nAlign the pinned branch in Project settings with the checkout, or switch the checkout.`
            );
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
      // Show progress on the card — chat stays closed until the user opens it.
      upsertTaskInState({ ...task, startupPhase: 'creating-session', startupError: undefined } as Task);
      const res = await createSession({ title: task.title, agent: resolved.id ?? resolved.name, model, directory });
      const session = res.session;
      if (!session?.id) {
        const msg = [
          res.error ?? 'Failed to create session — no id returned.',
          !isConnected ? 'Server is offline (DEMO mode). Open Server settings, Save & test the connection.' : undefined,
        ].filter(Boolean).join(' ');
        await fail(msg, task.id);
        await ensureFixTask(
          `Fix (infra): session create failed for ${task.title}`,
          `Session create failed for task "${task.title}" (${task.id}): ${msg}\nCheck OpenCode server, Server password, and project path.`
        );
        await loadData().catch(() => {});
        return;
      }
      sessionId = session.id;
      // Pin the real server-assigned session id to the task
      task = { ...task, sessionId: session.id };
      await updateTask(task.id, { sessionId: session.id, agentId: resolved.id, agentName: resolved.name, startupPhase: 'sending-prompt' } as unknown as Partial<Task>).catch(() => {});
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt' } as Task);
    } else {
      upsertTaskInState({ ...task, startupPhase: 'sending-prompt', startupError: undefined } as Task);
    }

    // Execute the task: title + description go out as the prompt message
    // on EVERY transition to running — including re-drops of an existing session.
    const prompt = buildTaskPrompt(task);
    console.log('startTaskExecution: sending prompt for task', task.id, '→ session', sessionId);
    const sent = await sendPrompt(sessionId, prompt, resolved.id);
    if (!sent.ok) {
      await fail(`Failed to send prompt: ${sent.error ?? 'unknown error'}`, task.id);
      await ensureFixTask(
        `Fix (infra): prompt send failed for ${task.title}`,
        `Prompt send failed for task "${task.title}" (${task.id}): ${sent.error ?? 'unknown error'}\nCheck OpenCode server, session ${sessionId}, and proxy /api/kanban/oc.`
      );
      await loadData().catch(() => {});
      return;
    }

    await updateTask(task.id, { startupPhase: 'ready' } as unknown as Partial<Task>).catch(() => {});
    upsertTaskInState({ ...task, startupPhase: 'ready', startupError: undefined, sessionId } as Task);
    await loadData();
    // Keep an already-open chat on this task in sync — but never steal/open
    // the chat window. It stays pinned to whatever the user explicitly opened.
    setChatTask((cur) => (cur?.id === task.id
      ? { ...task, sessionId, agentId: resolved.id, agentName: resolved.name, status: 'running' as const, startupPhase: 'ready' as const } as Task
      : cur));
  };

  // Auto-start: ANY task sitting in running without an active startup
  // gets executed — whether the user dragged it there or an agent flipped
  // it via kanban_update_status/plugin/PATCH. Covers external moves the drag
  // handler never sees (5s poll picks them up). In-flight guard prevents doubles.
  // Skips error-phase cards so a failed start doesn't loop; chat icon retries.
   // The server resets startupPhase on every transition to running, so a
   // deliberate re-run (done → backlog → running) still starts fresh.
  useEffect(() => {
    const candidates = tasks.running.filter((t) => {
      if (startingRef.current.has(t.id)) return false;
      // Offline-queued rows aren't on the server yet — replay first, and the
      // next poll picks them up with pendingSync cleared. Starting now would
      // create a session for a task id the server doesn't know.
      if (t.pendingSync) return false;
      if (['creating-session', 'sending-prompt', 'error'].includes(t.startupPhase as string)) return false;
      // Fresh (never started, or server reset on move): start.
      if (!t.startupPhase) return true;
      return false;
    });
    if (candidates.length === 0) return;
    for (const t of candidates) {
      startingRef.current.add(t.id);
      startTaskExecution(t).finally(() => {
        startingRef.current.delete(t.id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.running]);

  const handleMoveTask = async (task: Task, newStatus: TaskStatus) => {
    if (task.status === newStatus) return;
    moveTaskInState(task.id, newStatus);
    try {
      await moveTask(task.id, newStatus);
    } catch (e) {
      if (isQueuedOffline(e)) {
        upsertTaskInState({ ...task, status: newStatus, pendingSync: true });
      } else {
        console.warn('move failed, reverting', e);
        moveTaskInState(task.id, task.status);
      }
    } finally {
      refreshSyncState();
      loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
    }
  };

  const handleOpenChat = (task: Task) => {
    // Opening chat must never start execution or send the task prompt.
    // A task chat exists only after the task has its own server session.
    if (task.sessionId) setChatTask(task);
  };

  // One-click retry for error-phase cards: calls startTaskExecution directly
  // with a cleared session id (forces a fresh session) — no chat open.
  // In-flight guard prevents double-taps; auto-start skips error-phase so
  // this is the only path that restarts a failed card.
  const handleRetryTask = (task: Task) => {
    if (startingRef.current.has(task.id)) return;
    startingRef.current.add(task.id);
    const fresh = { ...task, sessionId: undefined, startupPhase: undefined, startupError: undefined } as Task;
    upsertTaskInState({ ...fresh, startupPhase: 'creating-session' } as Task);
    void startTaskExecution(fresh).finally(() => {
      startingRef.current.delete(task.id);
    });
  };

  const handleSaveTask = async (data: {
    title: string;
    description: string;
    acceptanceCriteria?: string;
    priority: TaskPriority;
    agentId?: string;
    agentName?: string;
    modelId?: string;
    modelProviderID?: string;
    result?: string;
    resultContext?: string;
  }) => {
    if (!activeProjectId) return;

    if (editingTask) {
      const modelChanged = data.modelId !== editingTask.modelId || data.modelProviderID !== editingTask.modelProviderID;
      const sessionReset = modelChanged && Boolean(editingTask.sessionId);
      const updatedTask = {
        ...editingTask,
        ...data,
        ...(sessionReset ? { sessionId: undefined, startupPhase: undefined, startupError: undefined } : {}),
      } as Task;
      // Optimistic: reflect edit instantly, persist in background.
      upsertTaskInState(updatedTask);
      setEditingTask(null);
      try {
        await updateTask(editingTask.id, {
          title: data.title,
          description: data.description,
          acceptanceCriteria: data.acceptanceCriteria,
          priority: data.priority,
          agentId: data.agentId,
          agentName: data.agentName,
          modelId: data.modelId,
          modelProviderID: data.modelProviderID,
          ...(sessionReset ? { sessionId: null, startupPhase: null, startupError: null } : {}),
          result: data.result,
          resultContext: data.resultContext,
        } as unknown as Partial<Task>);
      } catch (e) {
        if (isQueuedOffline(e)) {
          upsertTaskInState({ ...editingTask, ...data, pendingSync: true });
        } else {
          console.warn('update failed', e);
        }
      } finally {
        refreshSyncState();
        loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
      }
    } else {
      // Optimistic: insert a temp card instantly, swap in server row after.
      // Online: server assigns the id — swap temp card for the real row.
      // Offline (queued): replace the temp card with the queued row (real
      // replay id, QUEUED badge). Replay POSTs it on reconnect.
      const tempId = `temp-${Date.now()}`;
      const tempTask: Task = {
        id: tempId,
        projectId: activeProjectId,
        title: data.title,
         description: data.description,
         acceptanceCriteria: data.acceptanceCriteria,
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
      // Queued-write id: a real id (never temp-*) so replay POSTs a clean row
      // and the auto-start guard treats the queued card as a normal task.
      const queuedId = `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        const created = await createTask(
          activeProjectId,
          data.title,
          data.description,
          data.priority,
          data.agentId,
          data.agentName,
          undefined,
          data.modelId,
           data.modelProviderID,
           undefined,
           undefined,
           data.acceptanceCriteria,
            queuedId
        );
        // Online path: server echoed its row (same queuedId) — drop the temp
        // card and show the confirmed row.
        setTasks((prev) => ({
          ...prev,
          backlog: prev.backlog.filter((t) => t.id !== tempId),
        }));
        delete optimisticRef.current[tempId];
        upsertTaskInState(created);
      } catch (e) {
        if (isQueuedOffline(e)) {
          // Server unreachable — swap temp card for the queued row (real id,
          // QUEUED badge). Survives refresh via localStorage until replay.
          setTasks((prev) => ({
            ...prev,
            backlog: prev.backlog.filter((t) => t.id !== tempId),
          }));
          delete optimisticRef.current[tempId];
          upsertTaskInState({ ...tempTask, id: queuedId, pendingSync: true });
        } else {
          console.warn('create failed, removing temp card', e);
          setTasks((prev) => ({
            ...prev,
            backlog: prev.backlog.filter((t) => t.id !== tempId),
          }));
          delete optimisticRef.current[tempId];
        }
      } finally {
        refreshSyncState();
        loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
      }
    }
  };

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const handleDeleteTask = async (id: string) => {
    // Flag first so the card shows the spinner — the Python CLI round-trip
    // (cold-start + SQLite write + reload) can take several seconds.
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await deleteTask(id);
      await loadData();
    } catch (e) {
      console.warn('delete failed', e);
      await loadData().catch((e2) => { console.warn('refresh skipped (server down)', e2); });
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
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

  // Deep-link ?session=<id>: open that session's chat docked top-right.
  useEffect(() => {
    if (popoutSessionId || chatTask) return;
    const sid = new URLSearchParams(window.location.search).get('session');
    if (!sid) return;
    getTasks().then((all) => {
      const found = all.find((t) => t.sessionId === sid);
      if (found) {
        if (found.projectId !== activeProjectId) setActiveProjectId(found.projectId);
        setChatTask(found);
      }
    }).catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popoutSessionId]);

  const handleSaveProject = async (data: { name: string; folder: string; description: string; gitUrl?: string; gitBranch?: string; mkdir?: boolean }) => {
    const targetId = editingProject?.id ?? null;
    const folder = data.folder.trim();
    try {
      const { saveProject } = await import('./store/kanban');
      const saved = await saveProject(data, targetId);
      if (!editingProject && saved) setActiveProjectId(saved.id);
      if (saved && (saved.folder ?? '') !== folder) {
        alert(`Project saved, but stored folder differs:\ntyped: ${folder}\nstored: ${saved.folder ?? saved.path}`);
      }
    } catch (e: unknown) {
      alert(`Save failed: ${String((e as Error)?.message ?? e).slice(0, 400)}`);
      return;
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
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        if (activeProjectId) setShowAssistant(true);
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
                  <p className="text-[11px] muted mono -mt-px">{isConnected ? 'CONNECTED' : 'DEMO'} · {projects.length} project{projects.length === 1 ? '' : 's'}</p>
                </div>
              </div>

              {/* Connection status */}
              <button
                onClick={() => setShowServerModal(true)}
                title="Configure server connection"
                className={`pill ${isConnected ? 'p-green' : 'p-amber'}`}
              >
                {isConnected ? <Wifi className="w-3 h-3" strokeWidth={1.75} /> : <WifiOff className="w-3 h-3" strokeWidth={1.75} />}
              </button>
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
                onClick={() => { window.location.href = '/settings?from=desktop'; }}
                className="btn flex items-center px-2.5 py-1.5"
                title="Settings — theme, view, font size"
              >
                <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
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
                    onClick={() => setShowAssistant(true)}
                    className="btn flex items-center gap-1.5 px-3 py-2 text-[13px]"
                    title="Chat with board assistant — create tasks by telling it what to build"
                  >
                    <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.75} />
                    <span className="hidden lg:inline">Chat</span>
                  </button>
                  <button
                    onClick={handleAddTask}
                    className="btn btn-primary flex items-center gap-1.5 px-4 py-2 text-[14px] font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                    <span>New Task</span>
                    
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
      <OfflineBanner offline={offline} queued={queued} retrying={replaying} onRetry={handleSyncNow} />
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
                  onMove={handleMoveTask}
                  onRetry={handleRetryTask}
                  deletingIds={deletingIds}
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
      {showAssistant && (
        <AssistantChatWindow
          project={activeProject}
          availableAgents={availableAgents}
          onClose={() => setShowAssistant(false)}
        />
      )}
    </div>
  );
}
