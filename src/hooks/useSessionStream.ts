// Ported from opencode-kanban-agent useTaskStream: live session feed.
// v2 has SSE at GET /api/event (global bus) but no per-session stream, so this
// hook polls GET /api/session/{id}/message (paged { data, cursor }) with the
// same status/retry/dedupe semantics: connecting → live → closed/error/no-run.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessionMessages, getSession, subscribeSessionEvents } from '../api/opencode';
import { messageTimestamp, toChatMessages, type ChatMessage } from '../components/chatEvents';
import type { OpenCodeSessionInfo, SessionUsage } from '../types';

export type ChatStatus = 'connecting' | 'live' | 'closed' | 'error' | 'idle' | 'no-run';

function sessionErrorText(session: OpenCodeSessionInfo | null): string | null {
  if (!session) return null;
  const raw = session.error ?? session.providerError ?? session.provider_error;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const message = (raw as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

const POLL_MS = 2500;

/**
 * Scan the raw message list for live/closed status and the session outcome.
 * Array position is NOT chronological (an idle marker can sit mid-array), so
 * the idle check compares the idle marker's timestamp against the last chat
 * message's timestamp; it falls back to the old index comparison only when
 * either side lacks a timestamp (REQ-TIME-05).
 */
function scanSessionList(list: unknown[]): { idleLike: boolean; outcome: string | null } {
  let lastChatIndex = -1;
  let lastIdleIndex = -1;
  let lastChatTime = Number.NEGATIVE_INFINITY;
  let lastIdleTime = Number.NEGATIVE_INFINITY;
  let outcome: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const r = (list[i] ?? {}) as Record<string, unknown>;
    const t = typeof r.type === 'string' ? (r.type as string).toLowerCase() : '';
    const ts = messageTimestamp(r);
    if (t === 'idle') {
      lastIdleIndex = i;
      if (ts != null) lastIdleTime = Math.max(lastIdleTime, ts);
    } else if ((t === 'user' || t === 'assistant') && !(Array.isArray(r.content) && (r.content as unknown[]).length === 0)) {
      lastChatIndex = i;
      if (ts != null) lastChatTime = Math.max(lastChatTime, ts);
    }
    const o = typeof r.outcome === 'string' ? (r.outcome as string).toLowerCase() : '';
    if (o) outcome = o;
  }
  const timeKnown = Number.isFinite(lastChatTime) && Number.isFinite(lastIdleTime);
  const idleLike =
    lastChatIndex < 0 || (timeKnown ? lastIdleTime >= lastChatTime : lastIdleIndex > lastChatIndex);
  return { idleLike, outcome };
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMs(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') {
    // heuristic: seconds vs ms — unix s is ~1.7e9, ms is ~1.7e12
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
    const asNum = Number(v);
    if (Number.isFinite(asNum)) return asNum < 1e11 ? asNum * 1000 : asNum;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickTokens(src: Record<string, any> | undefined): Partial<SessionUsage> | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const pools: Array<Record<string, unknown>> = [];
  for (const k of ['tokens', 'usage', 'tokenUsage', 'counts']) {
    if (src[k] && typeof src[k] === 'object') pools.push(src[k] as Record<string, unknown>);
  }
  // also allow flat shape directly on src
  pools.push(src as Record<string, unknown>);
  for (const p of pools) {
    const input = num(p.input ?? p.inputTokens ?? p.promptTokens ?? p.prompt_tokens);
    const output = num(p.output ?? p.outputTokens ?? p.completionTokens ?? p.completion_tokens);
    const reasoning = num(p.reasoning ?? p.reasoningTokens ?? p.thinkingTokens);
    const total = num(p.total ?? p.totalTokens ?? p.total_tokens);
    const cost = num(p.cost ?? p.totalCost ?? p.price);
    if (input != null || output != null || total != null || reasoning != null || cost != null) {
      return {
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        reasoningTokens: reasoning ?? 0,
        totalTokens: total ?? (input ?? 0) + (output ?? 0) + (reasoning ?? 0),
        cost: cost,
      };
    }
  }
  return undefined;
}

function buildUsage(
  session: OpenCodeSessionInfo | null,
  rawList: unknown[],
  taskAgentName?: string | null,
): SessionUsage | null {
  if (!session && rawList.length === 0) return null;
  // Agent: session.agent/title wins, then task.agentName
  let agent: string | undefined;
  const sessAgent = (session as Record<string, unknown> | null)?.agent;
  if (typeof sessAgent === 'string' && sessAgent.trim()) agent = sessAgent.trim();
  else if (sessAgent && typeof sessAgent === 'object') {
    const o = sessAgent as Record<string, unknown>;
    agent = (o.name as string) || (o.id as string) || undefined;
  }
  if (!agent && typeof (session as Record<string, unknown> | null)?.title === 'string') {
    // title sometimes carries agent hint — don't use as agent
  }
  if (!agent && taskAgentName) agent = taskAgentName;

  // Model: session.model may be string, {providerID, modelID, id}, or Model.Ref
  let model: string | undefined;
  const rawModel = (session as Record<string, unknown> | null)?.model;
  if (typeof rawModel === 'string' && rawModel.trim()) model = rawModel.trim();
  else if (rawModel && typeof rawModel === 'object') {
    const m = rawModel as Record<string, unknown>;
    const prov = (m.providerID as string) || '';
    const mid = (m.modelID as string) || (m.id as string) || (m.model as string) || '';
    if (prov && mid) model = `${prov}/${mid}`;
    else if (mid) model = mid;
    else if (prov) model = prov;
  }
  // Some servers tuck model under session.info.model
  if (!model && session) {
    const info = (session as Record<string, unknown>).info as Record<string, unknown> | undefined;
    if (info?.model && typeof info.model === 'string') model = info.model;
  }

  // Elapsed: session.time.created → updated (fallback to message timestamps)
  let elapsedMs: number | undefined;
  const sessTime = (session as Record<string, unknown> | null)?.time as Record<string, unknown> | undefined;
  const cMs = toMs(sessTime?.created ?? (session as Record<string, unknown> | null)?.created ?? (session as Record<string, unknown> | null)?.createdAt);
  const uMs = toMs(sessTime?.updated ?? sessTime?.finished ?? (session as Record<string, unknown> | null)?.updated ?? (session as Record<string, unknown> | null)?.updatedAt);
  if (cMs != null && uMs != null && uMs >= cMs) elapsedMs = uMs - cMs;
  else if (cMs != null) elapsedMs = Date.now() - cMs;
  // fallback: span of message timestamps when session time missing
  if (elapsedMs == null && rawList.length > 0) {
    const stamps: number[] = [];
    for (const m of rawList) {
      if (!m || typeof m !== 'object') continue;
      const r = m as Record<string, unknown>;
      const cand = r.time ?? r.timestamp ?? r.created ?? (r.info as Record<string, unknown> | undefined)?.time;
      const ms = toMs(cand);
      if (ms != null) stamps.push(ms);
    }
    if (stamps.length >= 2) elapsedMs = Math.max(...stamps) - Math.min(...stamps);
    else if (stamps.length === 1) elapsedMs = Date.now() - stamps[0];
  }

  // Tokens: try session.tokens/cost, then per-message accumulation
  let tk: Partial<SessionUsage> | undefined = pickTokens(session as unknown as Record<string, unknown>);
  if (!tk || (tk.inputTokens === 0 && tk.outputTokens === 0 && tk.totalTokens === 0)) {
    // aggregate from messages
    let input = 0, output = 0, reasoning = 0, cost = 0, hasAny = false;
    for (const m of rawList) {
      if (!m || typeof m !== 'object') continue;
      const r = m as Record<string, unknown>;
      const cand = (r.tokens ?? r.usage ?? r.tokenUsage ?? (r.info as Record<string, unknown> | undefined)?.tokens) as Record<string, unknown> | undefined;
      const p = pickTokens(cand as Record<string, unknown>);
      if (p) {
        hasAny = true;
        input += p.inputTokens ?? 0;
        output += p.outputTokens ?? 0;
        reasoning += p.reasoningTokens ?? 0;
        if (p.cost != null) cost += p.cost;
      }
      // also try nested info.*
      const info = r.info as Record<string, unknown> | undefined;
      if (info) {
        const p2 = pickTokens(info as Record<string, unknown>);
        if (p2 && p2 !== p) {
          hasAny = true;
          input += p2.inputTokens ?? 0;
          output += p2.outputTokens ?? 0;
          reasoning += p2.reasoningTokens ?? 0;
          if (p2.cost != null) cost += p2.cost;
        }
      }
    }
    if (hasAny) tk = { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: input + output + reasoning, cost: cost || undefined };
  }
  const inputTokens = tk?.inputTokens ?? 0;
  const outputTokens = tk?.outputTokens ?? 0;
  const reasoningTokens = tk?.reasoningTokens ?? 0;
  const totalTokens = tk?.totalTokens ?? inputTokens + outputTokens + reasoningTokens;
  const costVal = tk?.cost;

  const messageCount = rawList.length;
  return {
    agent, model, elapsedMs,
    inputTokens, outputTokens, reasoningTokens, totalTokens,
    cost: costVal, messageCount,
  };
}

export function useSessionStream(sessionId: string | null, opts?: { taskAgentName?: string | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rawList, setRawList] = useState<unknown[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [session, setSession] = useState<OpenCodeSessionInfo | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  // Sequence guard: poll + SSE fetches run concurrently and can resolve
  // out of order. Only the latest response may touch state — otherwise a
  // stale snapshot reorders the feed (e.g. tool rows landing below the
  // session-end marker).
  const seqRef = useRef(0);

  // Reconcile, don't just append: a tool part keeps the same id
  // (`${msgId}-tool`) while its state flips pending → completed, so
  // dedup-by-id would freeze the row on "pending" forever. Incoming
  // rows replace same-id rows (status/detail update in place), order
  // follows the server list.
  const merge = useCallback((incomingRaw: unknown[]) => {
    setRawList(incomingRaw);
    const incoming = toChatMessages(incomingRaw);
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
      setSession(null);
      setRawList([]);
      setMessages([]);
      return;
    }
    // A fork is a different transcript. Clear the previous session before the
    // first poll so messages after an edited turn cannot leak into the branch.
    setMessages([]);
    setRawList([]);
    setStatus('connecting');

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    // Failures don't throw (the API helpers return null instead), so count
    // consecutive misses — after 2 in a row show error instead of spinning
    // on "connecting"/"live" forever.
    let missCount = 0;

    const poll = async () => {
      if (stopped) return;
      const seq = ++seqRef.current;
      try {
        const [list, sess] = await Promise.all([
          fetchSessionMessages(sessionId),
          getSession(sessionId),
        ]);
        if (stopped || seq !== seqRef.current) return;
        if (list === null) {
          // Message fetch failed (helper swallows HTTP/network errors as null).
          // Without this the UI would sit on "connecting" forever with the
          // composer locked. Two misses in a row = real error.
          if (++missCount >= 2) setStatus('error');
          if (sess) setSession(sess);
        } else {
          missCount = 0;
          if (sess) {
            setSession(sess);
            const so = typeof (sess as Record<string, unknown>)?.outcome === 'string'
              ? ((sess as Record<string, unknown>).outcome as string).toLowerCase()
              : null;
            if (so) setOutcome(so);
          }
          if (list) {
            merge(list as unknown[]);
            // Idle detection: the server list is not guaranteed chronological
            // (idle marker can arrive first / sit mid-array), so compare
            // timestamps instead of array indices. Any non-benign idle
            // outcome or missing chat message means the agent parked.
            // A fresh session with zero chat messages is always idle-ready,
            // otherwise a brand new board assistant idles as "live" forever
            // and locks the input before the first prompt.
            const scan = scanSessionList(Array.isArray(list) ? list : []);
            if (scan.outcome) setOutcome(scan.outcome);
            setStatus(scan.idleLike ? 'closed' : 'live');
          }
        }
      } catch {
        if (!stopped && seq === seqRef.current) setStatus('error');
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };

    // A session id that never existed (server restart/prune) answers 404 —
    // check first so we show no-run instead of polling forever.
    getSession(sessionId)
      .then((sess) => {
        if (stopped) return;
        if (!sess) {
          setStatus('no-run');
          return;
        }
        setSession(sess);
        // Live push via SSE bus + polling fallback for missed frames.
        unsub = subscribeSessionEvents(sessionId, () => {
          if (!stopped && sessionIdRef.current === sessionId) {
            const seq = ++seqRef.current;
            Promise.all([fetchSessionMessages(sessionId), getSession(sessionId)]).then(([list, s2]) => {
              if (stopped || seq !== seqRef.current) return;
              if (s2) setSession(s2);
              if (list) {
                merge(list as unknown[]);
                const scan2 = scanSessionList(Array.isArray(list) ? (list as unknown[]) : []);
                if (scan2.outcome) setOutcome(scan2.outcome);
                setStatus(scan2.idleLike ? 'closed' : 'live');
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

  const usage = buildUsage(session, rawList, opts?.taskAgentName ?? null);
  return { messages, status, session, sessionError: sessionErrorText(session), usage, outcome, retry: () => setAttempt((a) => a + 1) };
}
