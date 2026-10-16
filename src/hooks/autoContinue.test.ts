import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CONTINUE_DEFAULT_MIN,
  AUTO_CONTINUE_IDLE_MS,
  AUTO_CONTINUE_MIN_OPTIONS,
  AUTO_CONTINUE_PROMPT,
  autoContinueMinToMs,
  hasUserHistory,
  isIdleStatus,
  msUntilAutoContinue,
  normalizeAutoContinueMin,
  shouldAutoContinue,
  type AutoContinueInput,
} from './autoContinue.ts';

const NOW = 1_000_000;

function base(over: Partial<AutoContinueInput> = {}): AutoContinueInput {
  return {
    enabled: true,
    isAssistant: true,
    sessionId: 'ses_1',
    status: 'closed',
    busy: false,
    hasHistory: true,
    lastActivityAt: NOW - AUTO_CONTINUE_IDLE_MS,
    now: NOW,
    ...over,
  };
}

test('prompt is fixed, understandable and repeat-safe', () => {
  assert.equal(typeof AUTO_CONTINUE_PROMPT, 'string');
  assert.ok(AUTO_CONTINUE_PROMPT.length > 20);
  assert.match(AUTO_CONTINUE_PROMPT, /continue/i);
  assert.match(AUTO_CONTINUE_PROMPT, /board/i);
  assert.match(AUTO_CONTINUE_PROMPT, /do not repeat/i);
});

test('threshold: fires only at exactly 300000 ms or more', () => {
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 300000 })), true);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 299999 })), false);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 1 })), false);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW })), false);
  // idle threshold constant is the documented 5 minutes
  assert.equal(AUTO_CONTINUE_IDLE_MS, 300000);
});

test('reset: new activity restarts the window', () => {
  // Was idle long enough, then a new activity timestamp arrived.
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 500 })), false);
  // Unknown activity timestamp never fires.
  assert.equal(shouldAutoContinue(base({ lastActivityAt: null })), false);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: undefined })), false);
});

test('exclusions: disabled, task chat, no session', () => {
  assert.equal(shouldAutoContinue(base({ enabled: false })), false);
  assert.equal(shouldAutoContinue(base({ isAssistant: false })), false);
  assert.equal(shouldAutoContinue(base({ sessionId: null })), false);
  assert.equal(shouldAutoContinue(base({ sessionId: undefined })), false);
});

test('exclusions: busy states never fire', () => {
  assert.equal(shouldAutoContinue(base({ busy: true })), false);
});

test('exclusions: live/connecting/error/no-run statuses never fire', () => {
  assert.equal(shouldAutoContinue(base({ status: 'live' })), false);
  assert.equal(shouldAutoContinue(base({ status: 'connecting' })), false);
  assert.equal(shouldAutoContinue(base({ status: 'error' })), false);
  assert.equal(shouldAutoContinue(base({ status: 'no-run' })), false);
  assert.equal(shouldAutoContinue(base({ status: null })), false);
});

test('exclusions: fresh session without user history never fires', () => {
  assert.equal(shouldAutoContinue(base({ hasHistory: false })), false);
});

test('both closed and idle statuses are allowed', () => {
  assert.equal(shouldAutoContinue(base({ status: 'closed' })), true);
  assert.equal(shouldAutoContinue(base({ status: 'idle' })), true);
});

test('custom idleMs override works for fast tests', () => {
  assert.equal(shouldAutoContinue(base({ idleMs: 1000, lastActivityAt: NOW - 1000 })), true);
  assert.equal(shouldAutoContinue(base({ idleMs: 1000, lastActivityAt: NOW - 999 })), false);
});

test('hasUserHistory requires a non-empty user turn', () => {
  assert.equal(hasUserHistory([]), false);
  assert.equal(hasUserHistory(null), false);
  assert.equal(hasUserHistory(undefined), false);
  assert.equal(hasUserHistory([{ kind: 'assistant', markdown: 'hi' }]), false);
  assert.equal(hasUserHistory([{ kind: 'user', markdown: '   ' }]), false);
  assert.equal(hasUserHistory([{ kind: 'user', markdown: 'do it' }]), true);
  assert.equal(
    hasUserHistory([
      { kind: 'assistant', markdown: 'hello' },
      { kind: 'user', markdown: 'go' },
    ]),
    true,
  );
});

test('isIdleStatus only accepts closed and idle', () => {
  assert.equal(isIdleStatus('closed'), true);
  assert.equal(isIdleStatus('idle'), true);
  assert.equal(isIdleStatus('live'), false);
  assert.equal(isIdleStatus('connecting'), false);
  assert.equal(isIdleStatus('error'), false);
  assert.equal(isIdleStatus('no-run'), false);
  assert.equal(isIdleStatus(null), false);
});

test('msUntilAutoContinue counts down to zero and clamps', () => {
  assert.equal(msUntilAutoContinue(NOW - 0, NOW), AUTO_CONTINUE_IDLE_MS);
  assert.equal(msUntilAutoContinue(NOW - 299000, NOW), 1000);
  assert.equal(msUntilAutoContinue(NOW - 300000, NOW), 0);
  assert.equal(msUntilAutoContinue(NOW - 999999, NOW), 0);
  assert.equal(msUntilAutoContinue(null, NOW), AUTO_CONTINUE_IDLE_MS);
});

test('normalizeAutoContinueMin keeps known options and falls back to default', () => {
  for (const min of AUTO_CONTINUE_MIN_OPTIONS) {
    assert.equal(normalizeAutoContinueMin(min), min);
    assert.equal(normalizeAutoContinueMin(String(min)), min);
  }
  assert.equal(normalizeAutoContinueMin(7), AUTO_CONTINUE_DEFAULT_MIN);
  assert.equal(normalizeAutoContinueMin(-1), AUTO_CONTINUE_DEFAULT_MIN);
  assert.equal(normalizeAutoContinueMin('abc'), AUTO_CONTINUE_DEFAULT_MIN);
  assert.equal(normalizeAutoContinueMin(null), AUTO_CONTINUE_DEFAULT_MIN);
  assert.equal(normalizeAutoContinueMin(undefined), AUTO_CONTINUE_DEFAULT_MIN);
});

test('autoContinueMinToMs converts minutes to milliseconds', () => {
  assert.equal(autoContinueMinToMs(AUTO_CONTINUE_DEFAULT_MIN), AUTO_CONTINUE_IDLE_MS);
  assert.equal(autoContinueMinToMs(1), 60000);
  assert.equal(autoContinueMinToMs(30), 1800000);
});
