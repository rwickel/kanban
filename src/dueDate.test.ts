import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue } from './dueDate.ts';

describe('due dates', () => {
  it('treats dates before today as overdue, but not today or future dates', () => {
    const now = new Date(2026, 9, 18, 23, 59);
    assert.equal(isOverdue('2026-10-17', now), true);
    assert.equal(isOverdue('2026-10-18', now), false);
    assert.equal(isOverdue('2026-10-19', now), false);
  });
  it('uses local calendar boundaries and ignores empty dates', () => {
    assert.equal(isOverdue('2026-10-17', new Date(2026, 9, 18, 0, 1)), true);
    assert.equal(isOverdue('', new Date(2026, 9, 18)), false);
  });
});
