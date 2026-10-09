// Chat panel: live session feed + reply box — mono theme (light/dark vars).

import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  X, Send, Loader2, ExternalLink, Copy, Check,
  Bot, User, ChevronDown, Wrench, AlertTriangle,
} from 'lucide-react';
import { Task } from '../types';
import { sendPrompt } from '../api/opencode';
import { useSessionStream, type ChatStatus } from '../hooks/useSessionStream';
import type { ChatMessage } from './chatEvents';

interface SessionChatWindowProps {
  task: Task | null;
  onClose: () => void;
  /** Standalone mode: full-window chat (pop-out), no overlay/drag/popout buttons. */
  standalone?: boolean;
}

const STATUS_DOT: Record<ChatStatus, { bg: string; label: string; pulse: boolean }> = {
  idle: { bg: 'var(--muted)', label: 'idle', pulse: false },
  connecting: { bg: 'var(--amber)', label: 'connecting', pulse: true },
  live: { bg: 'var(--emerald)', label: 'live', pulse: true },
  closed: { bg: 'var(--muted)', label: 'closed', pulse: false },
  error: { bg: 'var(--danger)', label: 'stream error', pulse: false },
  'no-run': { bg: 'var(--muted)', label: 'no session', pulse: false },
};

function ThinkingBlock({ msg, showAvatar, agentName }: { msg: ChatMessage; showAvatar?: boolean; agentName?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      {showAvatar ? (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <Bot className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      ) : (
        <div className="w-6 shrink-0" />
      )}
      <div className="flex-1 min-w-0 max-w-[88%]">
        {showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest muted mb-1 ml-1 mono">{agentName}</p>
        )}
        <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-[11px] muted hoverable">
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
          <span className="font-medium mono uppercase tracking-wide">Thinking</span>
        </button>
        {open && (
          <div className="mt-1 panel p-2.5 text-[11.5px] leading-relaxed t-soft whitespace-pre-wrap break-words md-body">
            <Markdown>{msg.markdown}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolRow({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const isErr = msg.kind === 'error';
  const t = msg.tool;
  const executed = (t?.status ?? '').toLowerCase() === 'executed';
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        {isErr
          ? <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--danger)' }} strokeWidth={1.75} />
          : executed
            ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} />
            : <Wrench className="w-3.5 h-3.5 muted" strokeWidth={1.75} />}
      </div>
      <div className="flex-1 min-w-0 max-w-[88%]">
        <button onClick={() => setOpen((v) => !v)}
          className="btn w-full flex items-center gap-2 px-2.5 py-1.5 mono text-[11px] text-left">
          <span className="font-semibold shrink-0 t-strong">{isErr ? 'tool' : t?.tool ?? 'tool'}</span>
          {t?.summary && <span className="muted truncate font-sans">{t.summary}</span>}
          {t?.status && <span className={`ml-auto shrink-0 pill ${executed ? 'p-green' : isErr ? 'p-red' : 'p-neutral'}`}>{t.status}</span>}
          <ChevronDown className={`w-3 h-3 shrink-0 muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
        </button>
        {open && (
          <div className="mt-1 panel overflow-hidden">
            {t?.input && (
              <div className="px-2.5 py-2 border-b hairline" style={{ borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">Input</p>
                <pre className="mono text-[11px] leading-relaxed t-soft whitespace-pre-wrap break-words">{t.input}</pre>
              </div>
            )}
            {t?.output ? (
              <div className="px-2.5 py-2">
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">Result</p>
                <pre className="mono text-[11px] leading-relaxed muted whitespace-pre-wrap break-words">{t.output}</pre>
              </div>
            ) : isErr && msg.markdown ? (
              <div className="px-2.5 py-2">
                <pre className="mono text-[11px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--danger)' }}>{msg.markdown}</pre>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ msg, agentName, showAvatar = true }: { msg: ChatMessage; agentName?: string; showAvatar?: boolean }) {
  const isUser = msg.kind === 'user';
  return (
    <div className={`flex gap-2 animate-fadeIn ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (showAvatar ? (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <Bot className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      ) : <div className="w-6 shrink-0" />)}
      <div className={`min-w-0 max-w-[88%] ${isUser ? 'order-first' : ''}`}>
        {!isUser && showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest muted mb-1 ml-1 mono">{agentName}</p>
        )}
        <div className="md-body text-[12.5px] leading-relaxed break-words"
          style={isUser
            ? { background: 'var(--accent)', color: 'var(--accent-text)', border: '1px solid var(--accent)', borderRadius: 6, padding: '8px 10px' }
            : { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
          <Markdown>{msg.markdown}</Markdown>
        </div>
      </div>
      {isUser && (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6 }}>
          <User className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      )}
    </div>
  );
}

export default function SessionChatWindow({ task, onClose, standalone }: SessionChatWindowProps) {
  const sessionId = task?.sessionId ?? null;
  const { messages, status, retry } = useSessionStream(sessionId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const msgCount = messages.length;

  const body = (
    <>
      <div className="modal-head px-3.5 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="dot" style={{ background: st.bg }} />
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
          if (msg.kind === 'tool' || msg.kind === 'error') return <ToolRow key={msg.id} msg={msg} />;
          if (msg.kind === 'reasoning') return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={task.agentName} />;
          return <Bubble key={msg.id} msg={msg} agentName={msg.kind === 'user' ? undefined : task.agentName} showAvatar={msg.kind === 'user' ? true : startsTurn} />;
        })}
        <div ref={bottomRef} />
      </div>

      {sendError && <div className="px-3.5 pt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{sendError}</div>}
      <form onSubmit={handleSend} className="p-3 border-t hairline" style={{ borderTopWidth: 1, borderTopStyle: 'solid', background: 'var(--surface)' }}>
        <div className="flex gap-1.5 items-end">
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Reply to agent…  (↵ send)" className="input" />
          <button type="submit" disabled={!input.trim() || sending} className="btn btn-primary p-2 shrink-0" title="Send">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Send className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        </div>
      </form>
    </>
  );

  if (standalone) {
    return (
      <div className="h-screen flex flex-col" style={{ background: 'var(--surface)' }}>
        {body}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div data-chat-width className="relative h-full flex flex-col shrink-0" style={{ width, maxWidth: '90vw', background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
        <div onPointerDown={onHandlePointerDown} title="Drag to resize"
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />
        {body}
      </div>
    </div>
  );
}
