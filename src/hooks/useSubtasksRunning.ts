// Track board tasks that are still running.
//
// The board assistant delegates work to subtasks. While a subtask runs the
// assistant session is idle (it waits for the result), so the auto-continue
// timer would fire and inject a "continue" prompt in the middle of that
// work. This hook reports "some task of this project is running" so the
// auto-continue stays off until the board is quiet again.

import { useEffect, useState } from 'react';
import { getTasks } from '../store/kanban';
import { hasRunningTask } from './subtasks';

export { hasRunningTask } from './subtasks';

/** How often the task list is checked. */
const POLL_MS = 3000;

/**
 * Poll the tasks of a project and report whether any of them still runs.
 * The poll only runs when `enabled` is true, so an unused chat costs nothing.
 */
export function useSubtasksRunning(projectId: string | null | undefined, enabled: boolean): boolean {
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!enabled || !projectId) {
      setRunning(false);
      return;
    }
    let stopped = false;
    const check = async () => {
      try {
        const tasks = await getTasks(projectId);
        if (stopped) return;
        setRunning(hasRunningTask(tasks));
      } catch {
        // Keep the last value. A failed read must not unblock the timer.
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [projectId, enabled]);

  return running;
}
