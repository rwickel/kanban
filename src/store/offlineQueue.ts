// Offline write queue: failed creates/updates wait in localStorage and replay
// FIFO on reconnect (see replayOfflineQueue in kanban.ts).
// Every mutation emits `kanban-queue-change` so useOfflineSync refreshes the banner.
//
// Tested via `node --test src/store/offlineQueue.test.ts`
// (package.json test glob covers src/**/*.test.ts).
import type { TaskPriority } from '../types';

export type QueuedOp =
  | {
      qid: string; kind: 'create'; at: number;
      clientId: string; projectId: string; title: string; description: string; acceptanceCriteria?: string;
      blockedByTaskIds?: string[];
      priority: TaskPriority;
      agentId?: string; agentName?: string; sessionId?: string;
      modelId?: string; modelProviderID?: string;
    }
  | { qid: string; kind: 'update'; at: number; id: string; updates: Record<string, unknown> };

export type NewQueuedOp =
  | Omit<Extract<QueuedOp, { kind: 'create' }>, 'qid' | 'at'>
  | Omit<Extract<QueuedOp, { kind: 'update' }>, 'qid' | 'at'>;

const LS_QUEUE = 'kanban_offline_queue';
export const QUEUE_CHANGE_EVENT = 'kanban-queue-change';

// node --test has no localStorage — fall back to memory so queue logic stays testable.
let memQueue: QueuedOp[] = [];

function load(): QueuedOp[] {
  try {
    const raw = localStorage.getItem(LS_QUEUE);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as QueuedOp[]) : [];
  } catch {
    return [...memQueue];
  }
}

function save(ops: QueuedOp[]): void {
  try {
    localStorage.setItem(LS_QUEUE, JSON.stringify(ops));
  } catch {
    memQueue = [...ops];
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(QUEUE_CHANGE_EVENT));
    }
  } catch { /* non-DOM (tests) */ }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Updates for one task merge (only the final state replays); creates append. */
export function enqueue(op: NewQueuedOp): QueuedOp {
  const ops = load();
  if (op.kind === 'update') {
    const prev = ops.find((o): o is Extract<QueuedOp, { kind: 'update' }> => o.kind === 'update' && o.id === op.id);
    if (prev) {
      prev.updates = { ...prev.updates, ...op.updates };
      prev.at = Date.now();
      save(ops);
      return prev;
    }
  }
  const full: QueuedOp = { ...op, qid: newId(), at: Date.now() } as QueuedOp;
  save([...ops, full]);
  return full;
}

export function listOps(): QueuedOp[] {
  return load();
}

export function queueCount(): number {
  return load().length;
}

export function removeOp(qid: string): void {
  save(load().filter((o) => o.qid !== qid));
}

export function clearQueue(): void {
  save([]);
}

/** fetch() throws TypeError on network failure; our api() abort → AbortError. */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e as Error)?.name === 'AbortError';
}

/** Thrown by createTask/updateTask when the write was queued for replay. */
export class QueuedOfflineError extends Error {
  queued = true as const;
  taskId?: string;
  constructor(message: string, taskId?: string) {
    super(message);
    this.name = 'QueuedOfflineError';
    this.taskId = taskId;
  }
}

export function isQueuedOffline(e: unknown): boolean {
  return e instanceof QueuedOfflineError || Boolean((e as { queued?: unknown } | null)?.queued);
}
