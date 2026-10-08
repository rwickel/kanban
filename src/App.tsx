import { useState, useEffect, useCallback } from 'react';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  Plus,
  FolderKanban,
  Users,
  Settings,
  Trash2,
  ChevronDown,
  Layout,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Task, TaskStatus, TaskPriority, Project, Agent, OpenCodeAgentInfo } from './types';
import {
  getProjects,
  getActiveProjectId,
  setActiveProjectId,
  createProject,
  updateProject,
  deleteProject,
  getTasksByStatus,
  createTask,
  updateTask,
  deleteTask,
  moveTask,
} from './store/kanban';
import { fetchAgents, createSession, sendPrompt, getServerInfo } from './api/opencode';
import KanbanColumn from './components/KanbanColumn';
import TaskModal from './components/TaskModal';
import ProjectModal from './components/ProjectModal';
import AgentTeamModal from './components/AgentTeamModal';
import TaskCard from './components/TaskCard';

const COLUMNS: { status: TaskStatus; title: string; icon: string }[] = [
  { status: 'backlog', title: 'Backlog', icon: '📋' },
  { status: 'running', title: 'Running', icon: '⚡' },
  { status: 'done', title: 'Done', icon: '✅' },
  { status: 'blocked', title: 'Blocked', icon: '🚫' },
];

export default function App() {
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

  const [showTaskModal, setShowTaskModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showAgentTeamModal, setShowAgentTeamModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const loadData = useCallback(() => {
    const projs = getProjects();
    setProjects(projs);

    let activeId = getActiveProjectId();
    if (!activeId && projs.length > 0) {
      activeId = projs[0].id;
      setActiveProjectId(activeId);
    }
    setActiveProjectIdState(activeId);

    if (activeId) {
      setTasks({
        backlog: getTasksByStatus(activeId, 'backlog'),
        running: getTasksByStatus(activeId, 'running'),
        done: getTasksByStatus(activeId, 'done'),
        blocked: getTasksByStatus(activeId, 'blocked'),
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
          { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#6366f1' },
          { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
          { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
          { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
          { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
        ]);
        setIsConnected(false);
      }
    } catch {
      setAgents([
        { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#6366f1' },
        { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
        { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
        { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
        { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
      ]);
      setIsConnected(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadAgents();
    getServerInfo().then(info => {
      if (info) setIsConnected(true);
    });
  }, [loadData, loadAgents]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        handleAddTask();
      }
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setEditingProject(null);
        setShowProjectModal(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const activeProject = projects.find(p => p.id === activeProjectId) || null;
  const availableAgents = activeProject
    ? agents.filter(a => activeProject.agentIds.includes(a.id))
    : [];

  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as Task;
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const task = active.data.current?.task as Task;
    const newStatus = over.data.current?.status as TaskStatus;

    if (task && newStatus && task.status !== newStatus) {
      moveTask(task.id, newStatus);
      loadData();

      if (newStatus === 'running' && task.agentId && !task.sessionId) {
        await createSessionForTask(task);
      }
    }
  };

  const createSessionForTask = async (task: Task) => {
    if (!task.agentId) return;

    const prompt = `Task: ${task.title}\n\nDescription: ${task.description}\n\nPriority: ${task.priority}\n\nPlease start working on this task.`;
    const session = await createSession(task.agentId, task.title);

    if (session) {
      updateTask(task.id, { sessionId: session.id });
      await sendPrompt(session.id, prompt);
      loadData();
    }
  };

  const handleSaveTask = (data: {
    title: string;
    description: string;
    priority: TaskPriority;
    agentId?: string;
    agentName?: string;
  }) => {
    if (!activeProjectId) return;

    if (editingTask) {
      updateTask(editingTask.id, {
        title: data.title,
        description: data.description,
        priority: data.priority,
        agentId: data.agentId,
        agentName: data.agentName,
      });
    } else {
      createTask(
        activeProjectId,
        data.title,
        data.description,
        data.priority,
        data.agentId,
        data.agentName
      );
    }
    setEditingTask(null);
    loadData();
  };

  const handleDeleteTask = (id: string) => {
    deleteTask(id);
    loadData();
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setShowTaskModal(true);
  };

  const handleOpenChat = (task: Task) => {
    if (task.sessionId) {
      window.open(`#session/${task.sessionId}`, '_blank');
    }
  };

  const handleStartTask = async (task: Task) => {
    moveTask(task.id, 'running');
    if (task.agentId && !task.sessionId) {
      await createSessionForTask(task);
    }
    loadData();
  };

  const handleSaveProject = (data: { name: string; path: string; description: string }) => {
    if (editingProject) {
      updateProject(editingProject.id, data);
    } else {
      const newProject = createProject(data.name, data.path, data.description);
      setActiveProjectId(newProject.id);
    }
    setEditingProject(null);
    loadData();
  };

  const handleDeleteProject = (id: string) => {
    if (confirm('Delete this project and all its tasks?')) {
      deleteProject(id);
      loadData();
    }
  };

  const handleSwitchProject = (id: string) => {
    setActiveProjectId(id);
    setActiveProjectIdState(id);
    setShowProjectDropdown(false);

    setTasks({
      backlog: getTasksByStatus(id, 'backlog'),
      running: getTasksByStatus(id, 'running'),
      done: getTasksByStatus(id, 'done'),
      blocked: getTasksByStatus(id, 'blocked'),
    });
  };

  const handleSaveAgentTeam = (agentIds: string[]) => {
    if (activeProjectId) {
      updateProject(activeProjectId, { agentIds });
      loadData();
    }
  };

  const handleAddTask = () => {
    setEditingTask(null);
    setShowTaskModal(true);
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-full mx-auto px-4 py-2.5">
          <div className="flex items-center justify-between">
            {/* Left: Logo & Title */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-[4px] bg-slate-900 flex items-center justify-center">
                  <Layout className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h1 className="text-[13px] font-semibold text-slate-900">Kanban Agent Board</h1>
                  <p className="text-[10px] text-slate-500 -mt-0.5">OpenCode v2</p>
                </div>
              </div>

              {/* Connection status */}
              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-[3px] text-[10px] font-medium ${
                isConnected ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
              }`}>
                {isConnected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
                <span>{isConnected ? 'Connected' : 'Demo'}</span>
              </div>
            </div>

            {/* Center: Project Selector */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-[4px] border border-slate-200 hover:border-slate-300 transition-all"
                >
                  <FolderKanban className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-[12px] font-medium text-slate-700">
                    {activeProject?.name || 'Select project'}
                  </span>
                  <ChevronDown className="w-3 h-3 text-slate-400" />
                </button>

                {/* Dropdown */}
                {showProjectDropdown && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowProjectDropdown(false)} />
                    <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.08)] z-20 overflow-hidden">
                      <div className="p-1.5 max-h-56 overflow-y-auto">
                        {projects.length === 0 ? (
                          <p className="text-[11px] text-slate-500 p-2 text-center">No projects yet</p>
                        ) : (
                          projects.map((project) => (
                            <div
                              key={project.id}
                              className={`flex items-center justify-between p-2 rounded-[4px] cursor-pointer transition-colors ${
                                project.id === activeProjectId
                                  ? 'bg-slate-100 border border-slate-200'
                                  : 'hover:bg-slate-50'
                              }`}
                            >
                              <button
                                onClick={() => handleSwitchProject(project.id)}
                                className="flex-1 text-left"
                              >
                                <p className="text-[12px] font-medium text-slate-900">{project.name}</p>
                                <p className="text-[10px] text-slate-500 font-mono truncate">{project.path}</p>
                              </button>
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingProject(project);
                                    setShowProjectModal(true);
                                  }}
                                  className="p-1 rounded-[3px] hover:bg-slate-200 text-slate-400 hover:text-slate-700"
                                >
                                  <Settings className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteProject(project.id);
                                  }}
                                  className="p-1 rounded-[3px] hover:bg-red-50 text-slate-400 hover:text-red-600"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="p-1.5 border-t border-slate-100">
                        <button
                          onClick={() => {
                            setEditingProject(null);
                            setShowProjectModal(true);
                            setShowProjectDropdown(false);
                          }}
                          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-[4px] border border-slate-200 text-slate-700 text-[11px] font-medium hover:bg-slate-50 transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                          New project
                          <span className="ml-auto"><kbd>P</kbd></span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-1.5">
              {activeProject && (
                <>
                  <button
                    onClick={() => setShowAgentTeamModal(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] border border-slate-200 hover:border-slate-300 text-[11px] text-slate-700 font-medium transition-all"
                    title="Configure agent team"
                  >
                    <Users className="w-3.5 h-3.5 text-slate-500" />
                    <span>Team</span>
                    {availableAgents.length > 0 && (
                      <span className="px-1 py-0.5 rounded-[3px] bg-slate-100 text-slate-600 text-[10px] font-mono">
                        {availableAgents.length}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={handleAddTask}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] bg-slate-900 text-white text-[11px] font-medium hover:bg-slate-800 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>New task</span>
                    <kbd className="ml-1 bg-slate-800 border-slate-700 text-slate-300">N</kbd>
                  </button>
                </>
              )}
              {!activeProject && (
                <button
                  onClick={() => {
                    setEditingProject(null);
                    setShowProjectModal(true);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[4px] bg-slate-900 text-white text-[11px] font-medium hover:bg-slate-800 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New project</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-4">
        {!activeProject ? (
          <div className="flex flex-col items-center justify-center h-[calc(100vh-100px)]">
            <div className="w-16 h-16 rounded-[6px] bg-slate-100 border border-slate-200 flex items-center justify-center mb-4">
              <FolderKanban className="w-8 h-8 text-slate-400" />
            </div>
            <h2 className="text-[15px] font-semibold text-slate-900 mb-1">Welcome to Kanban Agent Board</h2>
            <p className="text-[12px] text-slate-500 mb-4 text-center max-w-sm">
              Create a project to get started. Manage tasks with AI agents powered by OpenCode v2.
            </p>
            <button
              onClick={() => {
                setEditingProject(null);
                setShowProjectModal(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] bg-slate-900 text-white text-[12px] font-medium hover:bg-slate-800 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Create your first project
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 overflow-x-auto pb-2">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.status}
                  status={col.status}
                  title={col.title}
                  icon={col.icon}
                  tasks={tasks[col.status]}
                  onEditTask={handleEditTask}
                  onDeleteTask={handleDeleteTask}
                  onOpenChat={handleOpenChat}
                  onAddTask={handleAddTask}
                  onStartTask={handleStartTask}
                />
              ))}
            </div>

            <DragOverlay>
              {activeTask ? (
                <div className="rotate-1 scale-105">
                  <TaskCard
                    task={activeTask}
                    onEdit={() => {}}
                    onDelete={() => {}}
                    onOpenChat={() => {}}
                    onStartTask={() => {}}
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
    </div>
  );
}
