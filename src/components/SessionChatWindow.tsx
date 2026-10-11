// Chat panel: live session feed + reply box — mono theme (light/dark vars).

import { useEffect, useRef, useState } from 'react';
import {
  X, Send, Loader2, ExternalLink, Copy, Check, Download, Square,
} from 'lucide-react';
import { Task } from '../types';
import { sendPrompt, interruptSession } from '../api/opencode';
import { useSessionStream } from '../hooks/useSessionStream';
import { chatToMarkdown } from './chatEvents';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow } from './ChatFeed';
import FilePreviewModal from './FilePreviewModal';

interface SessionChatWindowProps {
  task: Task | null;
  onClose: () => void;
  /** Standalone mode: full-window chat (pop-out), no overlay/drag/popout buttons. */
  standalone?: boolean;
}

export default function SessionChatWindow({ task, onClose, standalone }: SessionChatWindowProps) {
  const sessionId = task?.sessionId ?? null;
  const { messages, status, outcome, retry } = useSessionStream(sessionId, {
    taskAgentName: task?.agentName ?? null,
  });
  const autoMovedRef = useRef(false);
  const infraFixRef = useRef(false);
  // Infra self-healing: stream/proxy unreachable (e.g. 502) → backlog fix task.
  useEffect(() => {
    if (!task || infraFixRef.current || task.title.startsWith('Fix (infra):')) return;
    if (status !== 'error' || !sessionId) return;
    infraFixRef.current = true;
    import('../store/kanban').then(async ({ getTasks, createTask }) => {
      try {
        const existing = await getTasks(task.projectId);
        const title = `Fix (infra): chat stream unreachable for ${task.title}`;
        if (existing.some((t) => (t.status === 'backlog' || t.status === 'running') && t.title === title)) return;
        await createTask(task.projectId, title,
          `Chat stream for task "${task.title}" (${task.id}, session ${sessionId}) returned stream error (proxy 502?). Check OpenCode server on :4099, password in Server settings, and Vite /api/kanban/oc proxy.`,
          'high', task.agentId, task.agentName);
      } catch { /* best-effort */ }
    }).catch(() => {});
  }, [task?.id, status]);
  useEffect(() => { infraFixRef.current = false; }, [task?.id]);
  // Capture last assistant text for task result auto-fill on done/blocked.
  const lastResultRef = useRef('');
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.kind === 'assistant' && m.markdown.trim());
    if (last) lastResultRef.current = last.markdown.trim().slice(0, 4000);
  }, [messages]);
  // Session ended -> board column follows: failed/error -> blocked, completed/done -> done.
  // Also writes result (last assistant message) if the agent didn't already.
  useEffect(() => {
    if (!task || autoMovedRef.current || task.status !== 'running' || status !== 'closed' || !outcome) return;
    const o = outcome.toLowerCase();
    const next: 'blocked' | 'done' | null =
      ['failed', 'error'].includes(o) ? 'blocked'
      : ['completed', 'done'].includes(o) ? 'done'
      : null;
    if (!next) return;
    autoMovedRef.current = true;
    const patch: Partial<Task> = { status: next };
    if (!task.result && lastResultRef.current) (patch as Record<string, unknown>).result = lastResultRef.current;
    if (!task.resultContext && next === 'blocked' && outcome) (patch as Record<string, unknown>).resultContext = `session outcome: ${outcome}`;
    import('../store/kanban').then(({ updateTask }) => updateTask(task.id, patch)).catch(() => { autoMovedRef.current = false; });
  }, [task?.id, task?.status, status, outcome]);
  useEffect(() => { autoMovedRef.current = false; }, [task?.id]);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem('kanban_chat_width');
      const n = raw ? Number(raw) : 448;
      return Number.isFinite(n) ? Math.min(800, Math.max(320, n)) : 448;
    } catch { return 448; }
  });
  const draggingRef = useRef(false);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startX - ev.clientX;
      const next = Math.min(800, Math.max(320, startW + dx));
      setWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-chat-width]') as HTMLElement | null;
        const w = el ? el.getBoundingClientRect().width : startW;
        try { localStorage.setItem('kanban_chat_width', String(Math.round(w))); } catch {}
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);
  useEffect(() => { setInput(''); setSendError(null); }, [sessionId]);

  if (!task) return null;
  const st = STATUS_DOT[status];

  // A session is "busy" while the SSE/poll feed says live or the last
  // assistant row still carries a non-completed tool (shell stuck, etc.).
  const busy = status === 'live' || status === 'connecting' || messages.some(
    (m) => m.kind === 'tool' && m.tool && !['executed', 'completed', 'error'].includes((m.tool.status || '').toLowerCase())
  );

  const handleStop = async () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    setSendError(null);
    const ok = await interruptSession(sessionId);
    setStopping(false);
    if (ok) retry();
    else setSendError('Stop failed — session may already be idle.');
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || !sessionId || sending) return;
    setSending(true);
    setSendError(null);
    const text = input.trim();
    const res = await sendPrompt(sessionId, text, task.agentId ?? task.agentName);
    setSending(false);
    if (res.ok) {
      setInput('');
      retry();
    } else {
      setSendError(`Failed to send — ${res.error ?? 'unknown error'}`);
    }
  };

  const copySessionId = async () => {
    if (!sessionId) return;
    try { await navigator.clipboard.writeText(sessionId); } catch {
      const el = document.createElement('input');
      el.value = sessionId; document.body.appendChild(el); el.select();
      document.execCommand('copy'); document.body.removeChild(el);
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const popOut = () => {
    window.open(`${window.location.pathname}#session/${sessionId}`, '_blank', 'width=480,height=720');
  };

  const exportMarkdown = () => {
    const md = chatToMarkdown(messages, { title: task.title, sessionId, agentName: task.agentName ?? undefined });
    const name = `${(task.title || 'session').replace(/[^\w\-]+/g, '-').slice(0, 60) || 'session'}-${(sessionId ?? 'no-session').slice(0, 12)}.md`;
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {
      // clipboard fallback
      try { navigator.clipboard.writeText(md); } catch { /* ignore */ }
    }
    setExported(true); setTimeout(() => setExported(false), 1500);
  };

  const msgCount = messages.length;

  const body = (
    <>
      <div className="modal-head px-3.5 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`dot ${st.pulse ? 'animate-pulse' : ''}`} style={{ background: st.bg }} />
              <p className="text-[11px] uppercase tracking-widest font-semibold t-strong mono truncate">{task.agentName ?? 'Agent'}</p>
              <span className="text-[10px] muted mono">· {st.label}{msgCount > 0 ? ` · ${msgCount}` : ''}</span>
            </div>
            <h2 className="text-[13px] font-semibold t-strong truncate">{task.title}</h2>
            <button onClick={copySessionId} title="Copy session id"
              className="pill p-neutral mt-1.5 max-w-full">
              <span className="truncate">{sessionId}</span>
              {copied ? <Check className="w-3 h-3" strokeWidth={1.75} /> : <Copy className="w-3 h-3" strokeWidth={1.75} />}
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={exportMarkdown} className="btn p-1.5" title="Export chat as Markdown">
              {exported ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />}
            </button>
            {!standalone && (
              <button onClick={popOut} className="btn p-1.5" title="Pop out"><ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
            )}
            <button onClick={onClose} className="btn p-1.5" title="Close"><X className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-3" style={{ background: 'var(--bg)' }}>
        {(status === 'connecting' || status === 'idle') && msgCount === 0 && (
          <div className="flex flex-col items-center justify-center h-40 gap-2 muted">
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
            <p className="text-[12px]">{status === 'connecting' ? 'Connecting…' : 'No events yet.'}</p>
          </div>
        )}
        {status === 'no-run' && (
          <div className="text-[12px] muted text-center py-8">
            No agent activity yet.{' '}<button type="button" className="underline t-strong" onClick={retry}>Check again</button>
          </div>
        )}
        {status === 'error' && msgCount === 0 && (
          <div className="text-[12px] p-3 text-center panel" style={{ color: 'var(--danger)' }}>
            Couldn't reach the stream.{' '}<button type="button" className="underline" onClick={retry}>Retry</button>
          </div>
        )}
        {messages.map((msg, idx) => {
          const prev = idx > 0 ? messages[idx - 1] : undefined;
          const startsTurn = msg.kind !== 'user' && (!prev || prev.kind === 'user');
          const modelHint = task.modelProviderID && task.modelId ? `${task.modelProviderID}/${task.modelId}` : task.modelId ?? undefined;
          if (msg.kind === 'tool') return <ToolRow key={msg.id} msg={msg} onFileClick={(p) => setPreviewPath(p)} />;
          if (msg.kind === 'error') return <ChatErrorRow key={msg.id} msg={msg} />;
          if (msg.kind === 'reasoning') return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={task.agentName} modelName={modelHint} onFileClick={(p) => setPreviewPath(p)} />;
          return <ChatBubble key={msg.id} msg={msg} agentName={msg.kind === 'user' ? undefined : task.agentName} modelName={msg.kind === 'user' ? undefined : modelHint} showAvatar={msg.kind === 'user' ? true : startsTurn} onFileClick={(p) => setPreviewPath(p)} />;
        })}
        <div ref={bottomRef} />
        {busy && msgCount > 0 && (
          <div className="flex gap-2 justify-start items-center animate-fadeIn">
            <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin muted" strokeWidth={1.75} />
            </div>
            <p className="text-[11px] muted mono">Agent running…</p>
          </div>
        )}
      </div>

      {sendError && <div className="px-3.5 pt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{sendError}</div>}
      <form onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend} className="p-3 border-t hairline" style={{ borderTopWidth: 1, borderTopStyle: 'solid', background: 'var(--surface)' }}>
        <div className="flex gap-1.5 items-end">
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? 'Session running — Stop to interrupt…' : 'Reply to agent…  (↵ send)'} className="input" disabled={busy} />
          {busy ? (
            <button type="submit" disabled={stopping || !sessionId} className="btn p-2 shrink-0" title="Stop running session" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              {stopping ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Square className="w-4 h-4" strokeWidth={1.75} />}
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || sending} className="btn btn-primary p-2 shrink-0" title="Send">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Send className="w-4 h-4" strokeWidth={1.75} />}
            </button>
          )}
        </div>
      </form>
    </>
  );

  if (standalone) {
    return (
      <div className="h-screen flex flex-col" style={{ background: 'var(--surface)' }}>
        {body}
        {previewPath && <FilePreviewModal absPath={previewPath} onClose={() => setPreviewPath(null)} />}
      </div>
    );
  }

  return (
    <div className="fixed top-3 right-3 bottom-3 z-50 flex justify-end pointer-events-none">
      <div data-chat-width className="relative h-full flex flex-col shrink-0 pointer-events-auto panel overflow-hidden" style={{ width, maxWidth: '90vw', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div onPointerDown={onHandlePointerDown} title="Drag to resize"
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />
        {body}
      </div>
      {previewPath && <FilePreviewModal absPath={previewPath} onClose={() => setPreviewPath(null)} />}
    </div>
  );
}
