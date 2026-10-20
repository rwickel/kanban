// Pure helpers for the board-assistant "Automatically continue" option.
// Kept free of React so Node's built-in test runner can exercise the exact
// threshold / reset / exclusion logic the chat window uses.

/** 5 minutes of real inactivity before an auto-continue may fire. */
export const AUTO_CONTINUE_IDLE_MS = 300000;

/** The fixed, understandable prompt injected into the same session. */
export const AUTO_CONTINUE_PROMPT =
  'Continue the project based on the current board and task state. Do not repeat work that is already done.';

/** Allowed idle times for auto-continue, in minutes. */
export const AUTO_CONTINUE_MIN_OPTIONS = [1, 5, 10, 15, 30] as const;
export type AutoContinueMin = (typeof AUTO_CONTINUE_MIN_OPTIONS)[number];

/** Default keeps REQ-AC-01: 5 minutes. */
export const AUTO_CONTINUE_DEFAULT_MIN: AutoContinueMin = 5;

/** Clamp any stored value to a known option. Unknown values fall back to the default. */
export function normalizeAutoContinueMin(value: unknown): AutoContinueMin {
  const n = typeof value === 'number' ? value : Number(value);
  return (AUTO_CONTINUE_MIN_OPTIONS as readonly number[]).includes(n)
    ? (n as AutoContinueMin)
    : AUTO_CONTINUE_DEFAULT_MIN;
}

/** Minutes to milliseconds for the timer. */
export function autoContinueMinToMs(min: number): number {
  return Math.max(1, Math.round(min)) * 60000;
}

/** Minimal message shape needed to detect a real user turn. */
export interface AutoContinueMessage {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'event';
  markdown?: string;
}

/** Chat stream status subset shared by desktop + mobile. */
export type AutoContinueStatus =
  | 'connecting'
  | 'live'
  | 'closed'
  | 'error'
  | 'idle'
  | 'no-run';

/**
 * True when the feed contains at least one non-empty user turn. A freshly
 * created session with no user history must never auto-continue.
 */
export function hasUserHistory(messages: readonly AutoContinueMessage[] | null | undefined): boolean {
  if (!messages || messages.length === 0) return false;
  return messages.some((m) => m.kind === 'user' && !!m.markdown?.trim());
}

/**
 * Whether a status counts as idle/closed for auto-continue. `no-run` and
 * `error` are excluded on purpose: a dead or unknown session must not be
 * re-prompted.
 */
export function isIdleStatus(status: AutoContinueStatus | string | null | undefined): boolean {
  return status === 'closed' || status === 'idle';
}

/** Everything the decision needs, in one snapshot. */
export interface AutoContinueInput {
  /** Checkbox is on. Off is the default. */
  enabled: boolean;
  /** Only board-assistant chats auto-continue, never normal task chats. */
  isAssistant: boolean;
  /** Same session id is required; never create a new session. */
  sessionId: string | null | undefined;
  status: AutoContinueStatus | string | null | undefined;
  /** sending || stopping || interrupted || live || connecting. */
  busy: boolean;
  /** Feed has a real user turn. */
  hasHistory: boolean;
  /** Epoch ms of the last visible activity, or null when unknown. */
  lastActivityAt: number | null | undefined;
  /** Epoch ms "now". Injectable for tests. */
  now: number;
  /** Threshold override for tests. */
  idleMs?: number;
}

/**
 * True when an auto-continue send may happen right now. Pure: same inputs,
 * same output. Callers reset `lastActivityAt` on new activity so the timer
 * restarts from zero.
 */
export function shouldAutoContinue(input: AutoContinueInput): boolean {
  const {
    enabled,
    isAssistant,
    sessionId,
    status,
    busy,
    hasHistory,
    lastActivityAt,
    now,
    idleMs = AUTO_CONTINUE_IDLE_MS,
  } = input;
  if (!enabled) return false;
  if (!isAssistant) return false;
  if (!sessionId) return false;
  if (busy) return false;
  if (!hasHistory) return false;
  if (!isIdleStatus(status)) return false;
  if (lastActivityAt == null) return false;
  return now - lastActivityAt >= idleMs;
}

/** Remaining ms until the next auto-continue is allowed (0 when due). */
export function msUntilAutoContinue(
  lastActivityAt: number | null | undefined,
  now: number,
  idleMs: number = AUTO_CONTINUE_IDLE_MS,
): number {
  if (lastActivityAt == null) return idleMs;
  return Math.max(0, lastActivityAt + idleMs - now);
}

const AUTO_CONTINUE_PREFIX = 'kanban_assistant_auto_continue_';

/**
 * Read the opt-in "Automatically continue" flag for a project. Default is OFF
 * so nothing auto-sends unless the user turns it on.
 */
export function readAutoContinuePref(projectId: string): boolean {
  try { return localStorage.getItem(`${AUTO_CONTINUE_PREFIX}${projectId}`) === '1'; } catch { return false; }
}

/** Persist the "Automatically continue" flag for a project. */
export function saveAutoContinuePref(projectId: string, enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(`${AUTO_CONTINUE_PREFIX}${projectId}`, '1');
    else localStorage.removeItem(`${AUTO_CONTINUE_PREFIX}${projectId}`);
  } catch { /* ignore */ }
}

const AUTO_CONTINUE_IDLE_KEY = 'kanban_auto_continue_idle_minutes';

/**
 * Read the configured idle time in minutes. Invalid or missing values fall
 * back to the 5-minute default.
 */
export function readAutoContinueIdleMin(): number {
  try { return normalizeAutoContinueMin(localStorage.getItem(AUTO_CONTINUE_IDLE_KEY)); } catch { return AUTO_CONTINUE_DEFAULT_MIN; }
}

/** Persist the configured idle time in minutes. */
export function saveAutoContinueIdleMin(minutes: number): void {
  try { localStorage.setItem(AUTO_CONTINUE_IDLE_KEY, String(normalizeAutoContinueMin(minutes))); } catch { /* ignore */ }
}
