import type { Task, TaskPriority, TaskStatus } from './types';

export interface TaskFilters {
  query: string;
  status: TaskStatus | '';
  priority: TaskPriority | '';
  assignee: string;
  labels?: string[];
}

export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const text = `${task.title} ${task.description} ${task.agentName ?? ''}`.toLocaleLowerCase();
    return (!query || text.includes(query)) &&
      (!filters.status || task.status === filters.status) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!filters.assignee || (task.agentId ?? task.agentName ?? '') === filters.assignee) &&
      (!filters.labels?.length || filters.labels.every((label) => task.labels?.includes(label)));
  });
}
