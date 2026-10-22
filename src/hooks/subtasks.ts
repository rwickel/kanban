// Pure helpers for the "board task still running" check.
//
// Kept free of React and of the store so the Node test runner can use the
// exact rule the chat window uses.

import type { Task } from '../types';

/** True when at least one task of the board is still running. */
export function hasRunningTask(tasks: Task[] | null | undefined): boolean {
  if (!tasks || tasks.length === 0) return false;
  return tasks.some((t) => t.status === 'running');
}
