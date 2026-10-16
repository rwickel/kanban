// Board-assistant "Automatically continue" hook. Shared by desktop
// (AssistantChatWindow) and mobile (MobileChat) so both behave identically.
//
// Contract:
//  - Default is OFF. Nothing sends until the user enables the checkbox.
//  - When enabled, an idle board-assistant session gets one fixed
//    continuation prompt injected into the SAME session after 5 minutes of
//    real inactivity. No new session, no board task.
//  - Exactly one send per inactivity cycle. The cycle resets on new
//    activity, session switch, new chat, or a finished send attempt.
//  - Send failures surface through the caller's send function and re-arm
//    the timer. Nothing sends after unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AUTO_CONTINUE_IDLE_MS,
  AUTO_CONTINUE_PROMPT,
  msUntilAutoContinue,
  shouldAutoContinue,
  type AutoContinueStatus,
} from './autoContinue';

export { AUTO_CONTINUE_PROMPT } from './autoContinue';

interface UseAutoContinueOptions {
  enabled: boolean;
  /** True only for the board-assistant chat, never for task chats. */
  isAssistant: boolean;
  sessionId: string | null;
  status: AutoContinueStatus;
  /** sending || stopping || interrupted || live || connecting */
  busy: boolean;
  /** Feed has at least one real user turn. */
  hasHistory: boolean;
  /** Changes on every new visible activity; each change restarts the cycle. */
  activityToken: string;
  /** The existing send path. Must target the SAME session id. */
  send: (text: string) => Promise<boolean>;
  /** Configured idle time in ms. Defaults to 300000 (5 minutes). */
  idleMs?: number;
}

/**
 * Runs the inactivity timer and fires `send(AUTO_CONTINUE_PROMPT)` once per
 * cycle. Returns the epoch-ms timestamp the current cycle started from.
 */
export function useAutoContinue(opts: UseAutoContinueOptions): number | null {
  const { enabled, isAssistant, sessionId, status, busy, hasHistory, activityToken } = opts;
  const idleMs = opts.idleMs ?? AUTO_CONTINUE_IDLE_MS;

  // Start of the current inactivity cycle. Null until first activity.
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);

  // Keep the latest send callback without re-arming the timer on each render.
  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;

  // One send per cycle, and no sends after unmount.
  const inflightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // New visible activity, session switch, or new chat restarts the cycle.
  useEffect(() => {
    inflightRef.current = false;
    setLastActivityAt(Date.now());
  }, [sessionId, activityToken]);

  // A busy stream keeps pushing the window forward, so the countdown only
  // starts after the session settles again.
  useEffect(() => {
    if (busy) {
      inflightRef.current = false;
      setLastActivityAt(Date.now());
    }
  }, [busy]);

  // The inactivity timer. Cleanup cancels the pending send, so nothing fires
  // after unmount, a session switch, or a new activity token.
  useEffect(() => {
    if (!enabled || !isAssistant || !sessionId) return;
    if (!hasHistory || busy || lastActivityAt == null) return;

    const delay = msUntilAutoContinue(lastActivityAt, Date.now(), idleMs);
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || !mountedRef.current || inflightRef.current) return;
      const due = shouldAutoContinue({
        enabled,
        isAssistant,
        sessionId,
        status,
        busy,
        hasHistory,
        lastActivityAt,
        now: Date.now(),
      });
      if (!due) return;
      inflightRef.current = true;
      void sendRef.current(AUTO_CONTINUE_PROMPT).then((ok) => {
        if (!mountedRef.current) return;
        // Success and failure both start a fresh cycle: success because the
        // run is now live, failure so a later cycle can retry once. The
        // error text itself is set inside the caller's send function.
        inflightRef.current = false;
        setLastActivityAt(Date.now());
      });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, isAssistant, sessionId, status, busy, hasHistory, lastActivityAt, idleMs]);

  return lastActivityAt;
}
