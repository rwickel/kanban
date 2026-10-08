import { Task, Project, TaskStatus, TaskPriority } from '../types';
import { v4 as uuidv4 } from 'uuid';

const TASKS_KEY = 'kanban_tasks';
const PROJECTS_KEY = 'kanban_projects';
const ACTIVE_PROJECT_KEY = 'kanban_active_project';

export function getTasks(): Task[] {
  try {
    const data = localStorage.getItem(TASKS_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Task[]): void {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

export function getProjects(): Project[] {
  try {
    const data = localStorage.getItem(PROJECTS_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export function getActiveProjectId(): string | null {
  return localStorage.getItem(ACTIVE_PROJECT_KEY);
}

export function setActiveProjectId(id: string | null): void {
  if (id) {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
  }
}

export function createProject(name: string, path: string, description: string): Project {
  const project: Project = {
    id: uuidv4(),
    name,
    path,
    description,
    agentIds: [],
    createdAt: new Date().toISOString(),
  };
  const projects = getProjects();
  projects.push(project);
  saveProjects(projects);
  return project;
}

export function updateProject(id: string, updates: Partial<Project>): Project | null {
  const projects = getProjects();
  const index = projects.findIndex(p => p.id === id);
  if (index === -1) return null;
  projects[index] = { ...projects[index], ...updates };
  saveProjects(projects);
  return projects[index];
}

export function deleteProject(id: string): void {
  const projects = getProjects().filter(p => p.id !== id);
  saveProjects(projects);
  const tasks = getTasks().filter(t => t.projectId !== id);
  saveTasks(tasks);
  if (getActiveProjectId() === id) {
    setActiveProjectId(projects.length > 0 ? projects[0].id : null);
  }
}

export function createTask(
  projectId: string,
  title: string,
  description: string,
  priority: TaskPriority,
  agentId?: string,
  agentName?: string,
  sessionId?: string
): Task {
  const task: Task = {
    id: uuidv4(),
    title,
    description,
    status: 'backlog',
    priority,
    agentId,
    agentName,
    sessionId,
    projectId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const tasks = getTasks();
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function updateTask(id: string, updates: Partial<Task>): Task | null {
  const tasks = getTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return null;
  tasks[index] = { ...tasks[index], ...updates, updatedAt: new Date().toISOString() };
  saveTasks(tasks);
  return tasks[index];
}

export function deleteTask(id: string): void {
  const tasks = getTasks().filter(t => t.id !== id);
  saveTasks(tasks);
}

export function moveTask(id: string, newStatus: TaskStatus): Task | null {
  return updateTask(id, { status: newStatus });
}

export function getTasksByProject(projectId: string): Task[] {
  return getTasks().filter(t => t.projectId === projectId);
}

export function getTasksByStatus(projectId: string, status: TaskStatus): Task[] {
  return getTasksByProject(projectId).filter(t => t.status === status);
}
