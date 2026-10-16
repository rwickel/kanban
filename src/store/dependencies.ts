// Client-side guards for task dependencies (blockedByTaskIds).
// The server is the authority (see server/kanban.py require_blocked_by /
// find_dependency_cycle); these pure helpers give the UI instant feedback
// before a request is sent and keep offline cache writes sane.
// Unit-tested via `node --test src/store/dependencies.test.ts`.
import type { Task } from '../types';

export const MAX_BLOCKED_BY = 50;

/** Trim, drop empties/dupes, cap length. Non-arrays → []. */
export function normalizeBlockedBy(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_BLOCKED_BY) break;
  }
  return out;
}

/** A task can never be blocked by itself. */
export function isSelfReference(taskId: string, ids: string[]): boolean {
  return ids.includes(taskId);
}

/**
 * Would replacing taskId's blockedBy list with `next` close a cycle?
 * Edge direction: task -> its blockedBy entries. Returns the offending id
 * (a predecessor that transitively depends on taskId) or null.
 */
export function findCycleTaskId(
  taskId: string,
  next: string[],
  tasks: Pick<Task, 'id' | 'blockedByTaskIds'>[],
): string | null {
  const graph = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.id === taskId) continue; // replaced below
    graph.set(t.id, normalizeBlockedBy(t.blockedByTaskIds));
  }
  // DFS from each new predecessor: if we can reach taskId, the edge closes a loop.
  const stack = [...next];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === taskId) return id;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (dep === taskId) return id;
      stack.push(dep);
    }
  }
  return null;
}

/**
 * Throw-style validation used by the store before PATCHing.
 * Mirrors the server rules so the UI can explain the problem without a round trip.
 */
export function validateBlockedBy(
  taskId: string,
  ids: unknown,
  tasks?: Pick<Task, 'id' | 'blockedByTaskIds'>[],
): string[] {
  const normalized = normalizeBlockedBy(ids);
  if (isSelfReference(taskId, normalized)) {
    throw new Error(`A task cannot be blocked by itself: ${taskId}`);
  }
  if (Array.isArray(ids) && ids.length > MAX_BLOCKED_BY) {
    throw new Error(`Too many blocked-by ids (max ${MAX_BLOCKED_BY}).`);
  }
  if (tasks) {
    const cycle = findCycleTaskId(taskId, normalized, tasks);
    if (cycle) {
      throw new Error(`Dependency cycle: ${taskId} -> ${cycle} -> ${taskId}`);
    }
  }
  return normalized;
}

/** True when every predecessor exists and is done. */
export function isReadyToStart(
  task: Pick<Task, 'id' | 'blockedByTaskIds'>,
  byId: Map<string, Pick<Task, 'status'>>,
): boolean {
  return normalizeBlockedBy(task.blockedByTaskIds).every((id) => byId.get(id)?.status === 'done');
}
