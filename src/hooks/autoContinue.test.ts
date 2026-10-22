import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_CONTINUE_DEFAULT_MIN,
  AUTO_CONTINUE_IDLE_MS,
  AUTO_CONTINUE_MIN_OPTIONS,
  AUTO_CONTINUE_PROMPT,
  AUTO_CONTINUE_STANDARD_MIN,
  autoContinueIdleMs,
  autoContinueMinToMs,
  formatAutoContinueIdle,
  hasUserHistory,
  isIdleStatus,
  msUntilAutoContinue,
  normalizeAutoContinueMin,
  readAutoContinuePrompt,
  saveAutoContinuePrompt,
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

test('default prompt is understandable and repeat-safe', () => {
  assert.equal(typeof AUTO_CONTINUE_PROMPT, 'string');
  assert.ok(AUTO_CONTINUE_PROMPT.length > 20);
  assert.match(AUTO_CONTINUE_PROMPT, /continue/i);
  assert.match(AUTO_CONTINUE_PROMPT, /board/i);
  assert.match(AUTO_CONTINUE_PROMPT, /do not repeat/i);
});

test('threshold: fires only at exactly 10000 ms or more', () => {
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 10000 })), true);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 9999 })), false);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW - 1 })), false);
  assert.equal(shouldAutoContinue(base({ lastActivityAt: NOW })), false);
  // idle threshold constant is the documented default of 10 seconds
  assert.equal(AUTO_CONTINUE_IDLE_MS, 10000);
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

test('exclusions: running subtasks block the auto-continue', () => {
  assert.equal(shouldAutoContinue(base({ subtasksRunning: true })), false);
  assert.equal(shouldAutoContinue(base({ subtasksRunning: false })), true);
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
  assert.equal(msUntilAutoContinue(NOW - 9000, NOW), 1000);
  assert.equal(msUntilAutoContinue(NOW - 10000, NOW), 0);
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
  assert.equal(autoContinueMinToMs(1), 60000);
  assert.equal(autoContinueMinToMs(30), 1800000);
});

test('autoContinueIdleMs uses the 10 second default for the standard choice', () => {
  assert.equal(autoContinueIdleMs(AUTO_CONTINUE_STANDARD_MIN), AUTO_CONTINUE_IDLE_MS);
  assert.equal(autoContinueIdleMs(AUTO_CONTINUE_STANDARD_MIN), 10000);
  assert.equal(autoContinueIdleMs(5), 300000);
  assert.equal(autoContinueIdleMs(1), 60000);
});

test('formatAutoContinueIdle describes the effective idle time', () => {
  assert.equal(formatAutoContinueIdle(AUTO_CONTINUE_STANDARD_MIN), '10 Sekunden');
  assert.equal(formatAutoContinueIdle(1), '1 Minute');
  assert.equal(formatAutoContinueIdle(15), '15 Minuten');
});

// Minimal localStorage stub for the prompt persistence tests.
function withLocalStorage(run: () => void) {
  const data = new Map<string, string>();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  try {
    run();
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test('readAutoContinuePrompt falls back to the default without storage', () => {
  // No stub: the helper must survive a missing or broken global.
  assert.equal(readAutoContinuePrompt(), AUTO_CONTINUE_PROMPT);
});

test('saveAutoContinuePrompt stores a custom prompt and read returns it', () => {
  withLocalStorage(() => {
    saveAutoContinuePrompt('Go on and finish the open tasks.');
    assert.equal(readAutoContinuePrompt(), 'Go on and finish the open tasks.');
  });
});

test('saveAutoContinuePrompt trims the stored value', () => {
  withLocalStorage(() => {
    saveAutoContinuePrompt('  Keep going with the plan.  ');
    assert.equal(readAutoContinuePrompt(), 'Keep going with the plan.');
  });
});

test('saveAutoContinuePrompt clears the entry for empty or default text', () => {
  withLocalStorage(() => {
    saveAutoContinuePrompt('custom prompt');
    assert.equal(readAutoContinuePrompt(), 'custom prompt');
    saveAutoContinuePrompt('   ');
    assert.equal(readAutoContinuePrompt(), AUTO_CONTINUE_PROMPT);
    saveAutoContinuePrompt('another custom prompt');
    saveAutoContinuePrompt(AUTO_CONTINUE_PROMPT);
    assert.equal(readAutoContinuePrompt(), AUTO_CONTINUE_PROMPT);
  });
});
