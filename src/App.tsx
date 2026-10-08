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
import { fetchAgents, createSession, getServerInfo } from './api/opencode';
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
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  // Drag state
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Load data
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

  useEffect(() => {
    loadData();
    loadAgents();

    // Check server connection
    getServerInfo().then(info => {
      if (info) setIsConnected(true);
    });
  }, [loadData, loadAgents]);

  // Active project
  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  // Get available agents for current project
  const availableAgents = activeProject
    ? agents.filter(a => activeProject.agentIds.includes(a.id))
    : [];

  // Handlers
  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as Task;
    if (task) setActiveTask(task);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const task = active.data.current?.task as Task;
    const newStatus = over.data.current?.status as TaskStatus;

    if (task && newStatus && task.status !== newStatus) {
      moveTask(task.id, newStatus);

      // If moving to running and task has an agent but no session, create one
      if (newStatus === 'running' && task.agentId && !task.sessionId) {
        createSessionForTask(task);
      }

      loadData();
    }
  };

  const createSessionForTask = async (task: Task) => {
    if (!task.agentId) return;
    const session = await createSession(task.agentId, task.title);
    if (session) {
      updateTask(task.id, { sessionId: session.id });
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
      // In a real app, this would open the OpenCode chat interface
      window.open(`#session/${task.sessionId}`, '_blank');
    }
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
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-gray-900/80 backdrop-blur-xl border-b border-gray-800/50">
        <div className="max-w-full mx-auto px-6 py-3">
          <div className="flex items-center justify-between">
            {/* Left: Logo & Title */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                  <Layout className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h1 className="text-base font-bold text-gray-100">Kanban Agent Board</h1>
                  <p className="text-[10px] text-gray-500 -mt-0.5">Powered by OpenCode v2</p>
                </div>
              </div>

              {/* Connection status */}
              <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
                isConnected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
              }`}>
                {isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                <span>{isConnected ? 'Connected' : 'Demo Mode'}</span>
              </div>
            </div>

            {/* Center: Project Selector */}
            <div className="flex items-center gap-3">
              <div className="relative">
                <button
                  onClick={() => setShowProjectDropdown(!showProjectDropdown)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-800/80 border border-gray-700/50 hover:border-gray-600 transition-all"
                >
                  <FolderKanban className="w-4 h-4 text-violet-400" />
                  <span className="text-sm font-medium text-gray-200">
                    {activeProject?.name || 'Select Project'}
                  </span>
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                </button>

                {/* Dropdown */}
                {showProjectDropdown && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowProjectDropdown(false)} />
                    <div className="absolute top-full left-0 mt-2 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-20 overflow-hidden">
                      <div className="p-2 max-h-64 overflow-y-auto">
                        {projects.length === 0 ? (
                          <p className="text-sm text-gray-500 p-3 text-center">No projects yet</p>
                        ) : (
                          projects.map((project) => (
                            <div
                              key={project.id}
                              className={`flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-colors ${
                                project.id === activeProjectId
                                  ? 'bg-violet-500/10 border border-violet-500/30'
                                  : 'hover:bg-gray-800'
                              }`}
                            >
                              <button
                                onClick={() => handleSwitchProject(project.id)}
                                className="flex-1 text-left"
                              >
                                <p className="text-sm font-medium text-gray-200">{project.name}</p>
                                <p className="text-xs text-gray-500 font-mono truncate">{project.path}</p>
                              </button>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingProject(project);
                                    setShowProjectModal(true);
                                  }}
                                  className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white"
                                >
                                  <Settings className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteProject(project.id);
                                  }}
                                  className="p-1 rounded hover:bg-red-900/50 text-gray-400 hover:text-red-400"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <div className="p-2 border-t border-gray-700/50">
                        <button
                          onClick={() => {
                            setEditingProject(null);
                            setShowProjectModal(true);
                            setShowProjectDropdown(false);
                          }}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-600/20 border border-violet-500/30 text-violet-300 text-sm font-medium hover:bg-violet-600/30 transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          New Project
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2">
              {activeProject && (
                <>
                  <button
                    onClick={() => setShowAgentTeamModal(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800/80 border border-gray-700/50 hover:border-gray-600 text-sm text-gray-300 hover:text-white transition-all"
                    title="Configure agent team"
                  >
                    <Users className="w-4 h-4 text-violet-400" />
                    <span className="hidden lg:inline">Team</span>
                    {availableAgents.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 text-xs">
                        {availableAgents.length}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={handleAddTask}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20"
                  >
                    <Plus className="w-4 h-4" />
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
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20"
                >
                  <Plus className="w-4 h-4" />
                  <span>New Project</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="p-6">
        {!activeProject ? (
          <div className="flex flex-col items-center justify-center h-[calc(100vh-120px)]">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/20 border border-violet-500/30 flex items-center justify-center mb-6">
              <FolderKanban className="w-10 h-10 text-violet-400" />
            </div>
            <h2 className="text-2xl font-bold text-gray-100 mb-2">Welcome to Kanban Agent Board</h2>
            <p className="text-gray-400 mb-6 text-center max-w-md">
              Create a project to get started. Manage tasks with AI agents powered by OpenCode v2.
            </p>
            <button
              onClick={() => {
                setEditingProject(null);
                setShowProjectModal(true);
              }}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20"
            >
              <Plus className="w-5 h-5" />
              Create Your First Project
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-5 overflow-x-auto pb-4">
              {COLUMNS.map((col) => (
                <KanbanColumn
                  key={col.status}
                  status={col.status}
                  title={col.title}
                  icon={col.icon}
                  tasks={tasks[col.status]}
                  color={col.status}
                  onEditTask={handleEditTask}
                  onDeleteTask={handleDeleteTask}
                  onOpenChat={handleOpenChat}
                  onAddTask={handleAddTask}
                />
              ))}
            </div>

            <DragOverlay>
              {activeTask ? (
                <div className="rotate-3 scale-105">
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
    </div>
  );
}
