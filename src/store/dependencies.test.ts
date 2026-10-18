import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BLOCKED_BY,
  normalizeBlockedBy,
  isSelfReference,
  findCycleTaskId,
  validateBlockedBy,
  isReadyToStart,
} from './dependencies.ts';

const A = 'task-a';
const B = 'task-b';
const C = 'task-c';
const D = 'task-d';

test('normalizeBlockedBy trims, dedupes and drops junk', () => {
  assert.deepEqual(normalizeBlockedBy([' a ', 'b', 'a', '', '  ', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeBlockedBy([42, null, { id: 'x' }]), []);
  assert.deepEqual(normalizeBlockedBy(undefined), []);
  assert.deepEqual(normalizeBlockedBy('a,b'), []);
});

test('normalizeBlockedBy caps the list length', () => {
  const many = Array.from({ length: MAX_BLOCKED_BY + 10 }, (_, i) => `t-${i}`);
  assert.equal(normalizeBlockedBy(many).length, MAX_BLOCKED_BY);
});

test('isSelfReference detects a task pointing at itself', () => {
  assert.equal(isSelfReference(A, [B, A]), true);
  assert.equal(isSelfReference(A, [B, C]), false);
  assert.equal(isSelfReference(A, []), false);
});

test('findCycleTaskId: acyclic replacement returns null', () => {
  const tasks = [
    { id: A, blockedByTaskIds: [B] },
    { id: B, blockedByTaskIds: [] },
  ];
  assert.equal(findCycleTaskId(A, [B], tasks), null);
  assert.equal(findCycleTaskId(A, [], tasks), null);
});

test('findCycleTaskId: direct two-node cycle is caught', () => {
  const tasks = [
    { id: A, blockedByTaskIds: [] },
    { id: B, blockedByTaskIds: [A] },
  ];
  // B already depends on A; making A depend on B closes A -> B -> A.
  assert.equal(findCycleTaskId(A, [B], tasks), B);
});

test('findCycleTaskId: longer chain is caught', () => {
  // Edge direction: task -> its blockedBy entries (the task waits for them).
  // D waits for C, C waits for B, B waits for A — so making A wait for D
  // would close the loop A -> D -> C -> B -> A. The offending predecessor
  // that points back at A is B.
  const tasks = [
    { id: B, blockedByTaskIds: [A] },
    { id: C, blockedByTaskIds: [B] },
    { id: D, blockedByTaskIds: [C] },
  ];
  assert.equal(findCycleTaskId(A, [D], tasks), B);
});

test('findCycleTaskId: unrelated branches do not false-positive', () => {
  const tasks = [
    { id: B, blockedByTaskIds: [C] },
    { id: C, blockedByTaskIds: [] },
    { id: D, blockedByTaskIds: [C] },
  ];
  assert.equal(findCycleTaskId(A, [D], tasks), null);
});

test('findCycleTaskId: self-edge is reported as a cycle too', () => {
  assert.equal(findCycleTaskId(A, [A], [{ id: B, blockedByTaskIds: [] }]), A);
});

test('validateBlockedBy returns the normalized list for valid input', () => {
  assert.deepEqual(validateBlockedBy(A, [' b ', 'b', 'c']), ['b', 'c']);
});

test('validateBlockedBy throws on self-reference', () => {
  assert.throws(() => validateBlockedBy(A, [B, A]), /cannot be blocked by itself/);
});

test('validateBlockedBy throws on cycle when task graph is provided', () => {
  const tasks = [
    { id: A, blockedByTaskIds: [] },
    { id: B, blockedByTaskIds: [A] },
  ];
  assert.throws(() => validateBlockedBy(A, [B], tasks), /cycle/i);
});

test('validateBlockedBy throws when the list is too long', () => {
  const many = Array.from({ length: MAX_BLOCKED_BY + 1 }, (_, i) => `t-${i}`);
  assert.throws(() => validateBlockedBy(A, many), /max/i);
});

test('isReadyToStart: no predecessors means ready', () => {
  assert.equal(isReadyToStart({ id: A, blockedByTaskIds: [] }, new Map()), true);
  assert.equal(isReadyToStart({ id: A }, new Map()), true);
});

test('isReadyToStart: all predecessors done means ready', () => {
  const byId = new Map([
    [B, { status: 'done' as const }],
    [C, { status: 'done' as const }],
  ]);
  assert.equal(isReadyToStart({ id: A, blockedByTaskIds: [B, C] }, byId), true);
});

test('isReadyToStart: pending or missing predecessor blocks', () => {
  const byId = new Map([
    [B, { status: 'done' as const }],
    [C, { status: 'running' as const }],
  ]);
  assert.equal(isReadyToStart({ id: A, blockedByTaskIds: [B, C] }, byId), false);
  assert.equal(isReadyToStart({ id: A, blockedByTaskIds: ['ghost'] }, byId), false);
});
