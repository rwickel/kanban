// Ported from opencode-kanban-agent useTaskStream: live session feed.
// v2 has SSE at GET /api/event (global bus) but no per-session stream, so this
// hook polls GET /api/session/{id}/message (paged { data, cursor }) with the
// same status/retry/dedupe semantics: connecting → live → closed/error/no-run.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessionMessages, getSession, subscribeSessionEvents } from '../api/opencode';
import { toChatMessages, type ChatMessage } from '../components/chatEvents';

export type ChatStatus = 'connecting' | 'live' | 'closed' | 'error' | 'idle' | 'no-run';

const POLL_MS = 2500;

export function useSessionStream(sessionId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);

  // Reconcile, don't just append: a tool part keeps the same id
  // (`${msgId}-tool`) while its state flips pending → completed, so
  // dedup-by-id would freeze the row on "pending" forever. Incoming
  // rows replace same-id rows (status/detail update in place), order
  // follows the server list.
  const merge = useCallback((rawList: unknown) => {
    const incoming = toChatMessages(rawList);
    if (incoming.length === 0) return;
    setMessages((prev) => {
      if (prev.length === 0) return incoming;
      const byId = new Map(prev.map((m) => [m.id, m]));
      let changed = false;
      for (const m of incoming) {
        const old = byId.get(m.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(m)) changed = true;
        byId.set(m.id, m);
      }
      if (!changed && incoming.length === prev.length) return prev;
      // Keep server order; append any local ids the server no longer sends.
      const order = incoming.map((m) => m.id);
      const incomingIds = new Set(order);
      for (const m of prev) if (!incomingIds.has(m.id)) order.push(m.id);
      return order.map((id) => byId.get(id)!).filter(Boolean);
    });
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    if (!sessionId) {
      setStatus('idle');
      return;
    }
    setStatus('connecting');

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;

    const poll = async () => {
      if (stopped) return;
      try {
        const list = await fetchSessionMessages(sessionId);
        if (stopped) return;
        if (list) {
          merge(list);
          // Idle detection: last raw message type "idle" (or outcome
          // interrupted/completed) means the agent parked — show closed,
          // not live, so the Stop button swaps back to Send.
          const arr = Array.isArray(list) ? list : [];
          const last = arr.length > 0 ? (arr[arr.length - 1] as Record<string, unknown>) : null;
          const ltype = typeof last?.type === 'string' ? (last.type as string).toLowerCase() : '';
          const outcome = typeof last?.outcome === 'string' ? (last.outcome as string).toLowerCase() : '';
          const idleLike = ltype === 'idle' || ['interrupted', 'completed', 'aborted', 'done'].includes(outcome);
          setStatus(idleLike ? 'closed' : 'live');
        }
      } catch {
        if (!stopped) setStatus('error');
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };

    // A session id that never existed (server restart/prune) answers 404 —
    // check first so we show no-run instead of polling forever.
    getSession(sessionId)
      .then((session) => {
        if (stopped) return;
        if (!session) {
          setStatus('no-run');
          return;
        }
        // Live push via SSE bus + polling fallback for missed frames.
        unsub = subscribeSessionEvents(sessionId, () => {
          if (!stopped && sessionIdRef.current === sessionId) {
            fetchSessionMessages(sessionId).then((list) => {
              if (list && !stopped) {
                merge(list);
                const arr = Array.isArray(list) ? list : [];
                const last = arr.length > 0 ? (arr[arr.length - 1] as Record<string, unknown>) : null;
                const ltype = typeof last?.type === 'string' ? (last.type as string).toLowerCase() : '';
                const outcome = typeof last?.outcome === 'string' ? (last.outcome as string).toLowerCase() : '';
                const idleLike = ltype === 'idle' || ['interrupted', 'completed', 'aborted', 'done'].includes(outcome);
                setStatus(idleLike ? 'closed' : 'live');
              }
            }).catch(() => {});
          }
        });
        poll();
      })
      .catch(() => {
        if (!stopped) setStatus('error');
      });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsub?.();
    };
  }, [sessionId, attempt, merge]);

  return { messages, status, retry: () => setAttempt((a) => a + 1) };
}
