import assert from 'node:assert/strict';
import test from 'node:test';

import { hasRunningTask } from './subtasks.ts';
import type { Task } from '../types';

function task(status: Task['status'], id = 't1'): Task {
  return { id, title: 'x', status, priority: 'medium' } as Task;
}

test('hasRunningTask is true when a task still runs', () => {
  assert.equal(hasRunningTask([task('running')]), true);
  assert.equal(hasRunningTask([task('done'), task('running', 't2')]), true);
});

test('hasRunningTask is false without running tasks', () => {
  assert.equal(hasRunningTask([]), false);
  assert.equal(hasRunningTask(null), false);
  assert.equal(hasRunningTask(undefined), false);
  assert.equal(hasRunningTask([task('backlog')]), false);
  assert.equal(hasRunningTask([task('done')]), false);
  assert.equal(hasRunningTask([task('blocked')]), false);
  assert.equal(hasRunningTask([task('archived')]), false);
});
