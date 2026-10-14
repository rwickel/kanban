import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enqueue,
  listOps,
  removeOp,
  clearQueue,
  queueCount,
  isNetworkError,
  isQueuedOffline,
  QueuedOfflineError,
} from './offlineQueue.ts';

test('create ops append in order', () => {
  clearQueue();
  enqueue({ kind: 'create', clientId: 'c1', projectId: 'p', title: 'A', description: '', priority: 'medium' });
  enqueue({ kind: 'create', clientId: 'c2', projectId: 'p', title: 'B', description: '', priority: 'high' });
  try {
    assert.equal(queueCount(), 2);
    const ops = listOps();
    assert.equal(ops[0]?.kind, 'create');
    assert.equal((ops[0] as { clientId?: string }).clientId, 'c1');
    assert.equal((ops[1] as { clientId?: string }).clientId, 'c2');
  } finally {
    clearQueue();
  }
});

test('update ops for one task merge into a single op', () => {
  clearQueue();
  try {
    enqueue({ kind: 'update', id: 't1', updates: { status: 'running' } });
    enqueue({ kind: 'update', id: 't1', updates: { priority: 'high' } });
    const ops = listOps();
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0], {
      qid: (ops[0] as { qid: string }).qid,
      kind: 'update',
      at: (ops[0] as { at: number }).at,
      id: 't1',
      updates: { status: 'running', priority: 'high' },
    });
  } finally {
    clearQueue();
  }
});

test('removeOp drops one entry, clearQueue empties', () => {
  clearQueue();
  const op = enqueue({ kind: 'update', id: 't9', updates: { status: 'done' } });
  assert.equal(queueCount(), 1);
  removeOp(op.qid);
  assert.equal(queueCount(), 0);
  enqueue({ kind: 'update', id: 't9', updates: { status: 'done' } });
  clearQueue();
  assert.deepEqual(listOps(), []);
});

test('isNetworkError matches fetch failures and aborts only', () => {
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isNetworkError(abort), true);
  assert.equal(isNetworkError(new Error('kanban API 500 on /api/kanban/tasks')), false);
  assert.equal(isNetworkError(null), false);
});

test('QueuedOfflineError flags queued writes', () => {
  const q = new QueuedOfflineError('Offline — update queued.', 't1');
  assert.equal(isQueuedOffline(q), true);
  assert.equal(q.taskId, 't1');
  assert.equal(isQueuedOffline(new Error('move failed')), false);
  assert.equal(isQueuedOffline(null), false);
});
