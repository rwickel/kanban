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
  const seenRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(null);

  const merge = useCallback((rawList: unknown) => {
    const fresh = toChatMessages(rawList).filter((m) => !seenRef.current.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seenRef.current.add(m.id);
    setMessages((prev) => [...prev, ...fresh]);
  }, []);

  useEffect(() => {
    seenRef.current = new Set();
    setMessages([]);
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
          setStatus((s) => (s === 'connecting' ? 'live' : s));
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
                setStatus((s) => (s === 'connecting' ? 'live' : s));
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
