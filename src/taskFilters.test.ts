import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks } from './taskFilters.ts';
import type { Task } from './types.ts';

const tasks: Task[] = [
  { id: '1', title: 'Ship search', description: 'Board tools', status: 'running', priority: 'high', agentId: 'a', agentName: 'Ada', labels: ['frontend', 'urgent'], projectId: 'p', createdAt: '', updatedAt: '' },
  { id: '2', title: 'Search docs', description: 'Write guide', status: 'done', priority: 'low', agentId: 'b', agentName: 'Lin', labels: ['docs'], projectId: 'p', createdAt: '', updatedAt: '' },
];

test('combines text, status, priority, and assignee filters', () => {
  assert.deepEqual(filterTasks(tasks, { query: 'SEARCH', status: 'running', priority: 'high', assignee: 'a' }).map(t => t.id), ['1']);
  assert.deepEqual(filterTasks(tasks, { query: '', status: '', priority: '', assignee: '' }), tasks);
});

test('filters by every selected label', () => {
  assert.deepEqual(filterTasks(tasks, { query: '', status: '', priority: '', assignee: '', labels: ['frontend'] }).map(t => t.id), ['1']);
  assert.deepEqual(filterTasks(tasks, { query: '', status: '', priority: '', assignee: '', labels: ['frontend', 'urgent'] }).map(t => t.id), ['1']);
});

test('returns an empty list when no task matches', () => {
  assert.deepEqual(filterTasks(tasks, { query: 'missing', status: '', priority: '', assignee: '' }), []);
});
