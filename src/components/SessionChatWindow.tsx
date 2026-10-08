// Chat panel: live session feed (useSessionStream) + reply box.
// Redesigned: gradient header, timeline messages, polished thinking blocks.

import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  X, Send, Loader2, ExternalLink, Copy, Check,
  Bot, User, Brain, ChevronDown, Wrench, AlertTriangle,
} from 'lucide-react';
import { Task } from '../types';
import { sendPrompt } from '../api/opencode';
import { useSessionStream, type ChatStatus } from '../hooks/useSessionStream';
import type { ChatMessage } from './chatEvents';

interface SessionChatWindowProps {
  task: Task | null;
  onClose: () => void;
}

const STATUS_STYLE: Record<ChatStatus, { dot: string; label: string; pulse: boolean }> = {
  idle: { dot: 'bg-gray-500', label: 'idle', pulse: false },
  connecting: { dot: 'bg-amber-400', label: 'connecting', pulse: true },
  live: { dot: 'bg-emerald-400', label: 'live', pulse: true },
  closed: { dot: 'bg-gray-500', label: 'closed', pulse: false },
  error: { dot: 'bg-red-400', label: 'stream error', pulse: false },
  'no-run': { dot: 'bg-gray-600', label: 'no session', pulse: false },
};

function ThinkingBlock({ msg, showAvatar, agentName }: { msg: ChatMessage; showAvatar?: boolean; agentName?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2.5 justify-start animate-fadeIn">
      {showAvatar ? (
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shrink-0 shadow-lg shadow-violet-500/25">
          <Bot className="w-3.5 h-3.5 text-white" />
        </div>
      ) : (
        <div className="w-7 shrink-0" />
      )}
      <div className="flex-1 min-w-0 max-w-[88%]">
        {showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/60 mb-1 ml-1">
            {agentName}
          </p>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-fuchsia-300 transition-colors"
        >
          <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          <Brain className="w-3 h-3 text-fuchsia-400/70" />
          <span className="font-medium tracking-wide">Agent thinking</span>
        </button>
        {open && (
          <div className="mt-1.5 relative overflow-hidden rounded-xl border border-fuchsia-500/10 bg-gray-950/60">
            <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-gradient-to-b from-fuchsia-400/60 via-violet-400/40 to-transparent" />
            <div className="pl-3.5 pr-3 py-2.5 text-[11.5px] leading-relaxed text-gray-400 whitespace-pre-wrap break-words md-body md-dim">
              <Markdown>{msg.markdown}</Markdown>
            </div>
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
  const running = ['running', 'pending', 'in_progress'].includes((t?.status ?? '').toLowerCase());
  return (
    <div className="flex gap-2.5 justify-start animate-fadeIn">
      <div className={`w-7 h-7 rounded-xl border flex items-center justify-center shrink-0 ${
        isErr
          ? 'bg-red-500/10 border-red-500/25'
          : executed
            ? 'bg-emerald-500/10 border-emerald-500/25'
            : 'bg-cyan-500/[0.08] border-cyan-500/20'
      }`}>
        {isErr
          ? <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
          : executed
            ? <Check className="w-3.5 h-3.5 text-emerald-400" />
            : running
              ? <Loader2 className="w-3.5 h-3.5 text-cyan-300 animate-spin" />
              : <Wrench className="w-3.5 h-3.5 text-cyan-300/90" />}
      </div>
      <div className="flex-1 min-w-0 max-w-[88%]">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border font-mono text-[11px] leading-relaxed break-words text-left transition-colors ${
            isErr
              ? 'bg-red-500/[0.07] border-red-500/25 text-red-300 hover:border-red-500/45'
              : executed
                ? 'bg-emerald-500/[0.06] border-emerald-500/25 hover:border-emerald-500/45'
                : 'bg-gray-950/50 border-gray-700/40 hover:border-gray-600/60'
          }`}
        >
          <span className={`font-semibold shrink-0 ${isErr ? 'text-red-300' : executed ? 'text-emerald-300' : 'text-cyan-300/90'}`}>
            {isErr ? 'tool' : t?.tool ?? 'tool'}
          </span>
          {t?.summary && <span className="text-gray-500 truncate">{t.summary}</span>}
          {t?.status && (
            <span className={`ml-auto shrink-0 px-1.5 py-px rounded-md text-[10px] font-sans font-medium ${
              executed
                ? 'bg-emerald-500/15 text-emerald-300'
                : isErr
                  ? 'bg-red-500/15 text-red-300'
                  : 'bg-gray-800 text-gray-500'
            }`}>
              {t.status}
            </span>
          )}
          <ChevronDown className={`w-3 h-3 shrink-0 text-gray-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="mt-1.5 rounded-xl border border-gray-700/40 bg-gray-950/60 overflow-hidden">
            {t?.input && (
              <div className="px-3 py-2 border-b border-gray-800/60">
                <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-1">Input</p>
                <pre className="font-mono text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-words">{t.input}</pre>
              </div>
            )}
            {t?.output ? (
              <div className="px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-1">Result</p>
                <pre className="font-mono text-[11px] leading-relaxed text-gray-400 whitespace-pre-wrap break-words">{t.output}</pre>
              </div>
            ) : isErr && msg.markdown ? (
              <div className="px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-1">Result</p>
                <pre className="font-mono text-[11px] leading-relaxed text-red-300 whitespace-pre-wrap break-words">{msg.markdown}</pre>
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
    <div className={`flex gap-2.5 animate-fadeIn ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (showAvatar ? (
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shrink-0 shadow-lg shadow-violet-500/25">
          <Bot className="w-3.5 h-3.5 text-white" />
        </div>
      ) : (
        <div className="w-7 shrink-0" />
      ))}
      <div className={`min-w-0 max-w-[88%] ${isUser ? 'order-first' : ''}`}>
        {!isUser && showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/60 mb-1 ml-1">
            {agentName}
          </p>
        )}
        <div className={`rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-relaxed break-words shadow-sm md-body ${
          isUser
            ? 'rounded-br-md bg-gradient-to-br from-violet-600 to-purple-700 text-white shadow-violet-900/30 border border-violet-400/20'
            : 'rounded-bl-md bg-gray-800/90 border border-gray-700/60 text-gray-200'
        }`}>
          <Markdown>{msg.markdown}</Markdown>
        </div>
      </div>
      {isUser && (
        <div className="w-7 h-7 rounded-xl bg-gray-700 border border-gray-600/50 flex items-center justify-center shrink-0">
          <User className="w-3.5 h-3.5 text-gray-300" />
        </div>
      )}
    </div>
  );
}

export default function SessionChatWindow({ task, onClose }: SessionChatWindowProps) {
  const sessionId = task?.sessionId ?? null;
  const { messages, status, retry } = useSessionStream(sessionId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    setInput('');
    setSendError(null);
  }, [sessionId]);

  if (!task) return null;
  const st = STATUS_STYLE[status];

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || !sessionId || sending) return;
    setSending(true);
    setSendError(null);
    const ok = await sendPrompt(sessionId, input.trim(), task.agentName);
    setSending(false);
    if (ok) setInput('');
    else setSendError('Failed to send message — the stream will pick it up on retry.');
  };

  const copySessionId = async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch {
      const el = document.createElement('input');
      el.value = sessionId;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const popOut = () => {
    window.open(`${window.location.pathname}#session/${sessionId}`, '_blank', 'width=480,height=720');
  };

  const msgCount = messages.length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-gray-900 border-l border-gray-700/60 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="relative overflow-hidden border-b border-gray-700/50">
          <div className="absolute inset-0 bg-gradient-to-r from-violet-600/15 via-purple-600/10 to-fuchsia-600/10 pointer-events-none" />
          <div className="relative flex items-start justify-between gap-2 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="relative flex w-2 h-2 shrink-0">
                  {st.pulse && (
                    <span className={`absolute inline-flex h-full w-full rounded-full ${st.dot} opacity-60 animate-ping`} />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${st.dot}`} />
                </span>
                <p className="text-[11px] uppercase tracking-widest text-violet-300 font-bold truncate">
                  {task.agentName ?? 'Agent'}
                </p>
                <span className="text-[10px] text-gray-500">· {st.label}{msgCount > 0 ? ` · ${msgCount}` : ''}</span>
              </div>
              <h2 className="text-sm font-semibold text-gray-100 truncate">{task.title}</h2>
              <button
                onClick={copySessionId}
                title="Click to copy full session id"
                className="mt-1.5 inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg bg-gray-950/70 border border-gray-700/70 hover:border-violet-500/50 text-[11px] font-mono text-gray-500 hover:text-gray-200 transition-colors"
              >
                <span className="truncate">{sessionId}</span>
                {copied ? <Check className="w-3 h-3 text-emerald-400 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
              </button>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={popOut} className="p-1.5 rounded-lg hover:bg-gray-700/70 text-gray-400 hover:text-white transition-colors" title="Open in separate browser window">
                <ExternalLink className="w-4 h-4" />
              </button>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-700/70 text-gray-400 hover:text-white transition-colors" title="Close chat">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3.5 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.05),transparent_60%)]">
          {(status === 'connecting' || status === 'idle') && msgCount === 0 && (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-gray-500">
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/20 border border-violet-500/20 flex items-center justify-center">
                <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
              </div>
              <p className="text-xs">{status === 'connecting' ? 'Connecting to agent stream…' : 'No events yet.'}</p>
            </div>
          )}
          {status === 'no-run' && (
            <div className="text-xs text-gray-500 text-center py-8">
              No agent activity yet — this session doesn't exist on the server.{' '}
              <button type="button" className="text-violet-400 hover:text-violet-300 underline" onClick={retry}>Check again</button>
            </div>
          )}
          {status === 'error' && msgCount === 0 && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-center">
              Couldn't reach the agent stream.{' '}
              <button type="button" className="underline hover:text-red-300" onClick={retry}>Retry</button>
            </div>
          )}
          {status !== 'no-run' && msgCount === 0 && status !== 'connecting' && status !== 'idle' && (
            <div className="text-xs text-gray-500 text-center py-8">
              No messages yet — the agent output will appear here once it starts working.
            </div>
          )}
          {messages.map((msg, idx) => {
            const prev = idx > 0 ? messages[idx - 1] : undefined;
            // A turn = unbroken run of agent-side rows (assistant/reasoning/tool)
            // between user messages. First row of each turn gets the avatar.
            const startsTurn =
              msg.kind !== 'user' &&
              (!prev || prev.kind === 'user');
            if (msg.kind === 'tool' || msg.kind === 'error') {
              return <ToolRow key={msg.id} msg={msg} />;
            }
            if (msg.kind === 'reasoning') {
              // Plain inline toggle — no bubble — in true message order.
              // First agent row of a turn carries the avatar + agent name.
              return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={task.agentName} />;
            }
            return (
              <Bubble
                key={msg.id}
                msg={msg}
                agentName={msg.kind === 'user' ? undefined : task.agentName}
                showAvatar={msg.kind === 'user' ? true : startsTurn}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        {sendError && <div className="px-4 pt-2 text-[11px] text-red-400">{sendError}</div>}
        <form onSubmit={handleSend} className="p-3.5 border-t border-gray-700/50 bg-gray-950/40">
          <div className="flex gap-2 items-end">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Reply to agent…"
              className="flex-1 min-w-0 px-3.5 py-2.5 bg-gray-800/90 border border-gray-700 rounded-xl text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="shrink-0 p-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 transition-all disabled:opacity-40 shadow-lg shadow-violet-900/40"
              title="Send message"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
