// Chat panel: live session feed (useSessionStream) + reply box.
// Ported from opencode-kanban-agent ChatDrawer, adapted to v2 REST + SSE bus.

import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { X, Send, Loader2, ExternalLink, Copy, Check, Bot, User } from 'lucide-react';
import { Task } from '../types';
import { sendPrompt } from '../api/opencode';
import { useSessionStream, type ChatStatus } from '../hooks/useSessionStream';

interface SessionChatWindowProps {
  task: Task | null;
  onClose: () => void;
}

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: 'idle',
  connecting: 'connecting…',
  live: 'live',
  closed: 'closed',
  error: 'stream error',
  'no-run': 'no session',
};

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

  // Reset input when switching tasks
  useEffect(() => {
    setInput('');
    setSendError(null);
  }, [sessionId]);

  if (!task) return null;

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-gray-900 border-l border-gray-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 p-4 border-b border-gray-700/50">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-violet-400 font-semibold mb-0.5">
              {task.agentName ?? 'Agent'}
            </p>
            <h2 className="text-sm font-semibold text-gray-100 truncate">{task.title}</h2>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={copySessionId}
                title="Click to copy full session id"
                className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 hover:border-violet-500/50 text-[11px] font-mono text-gray-400 hover:text-gray-200 transition-colors"
              >
                <span className="truncate">{sessionId}</span>
                {copied ? (
                  <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                ) : (
                  <Copy className="w-3 h-3 shrink-0" />
                )}
              </button>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                status === 'live'
                  ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                  : status === 'error'
                    ? 'text-red-400 border-red-500/30 bg-red-500/10'
                    : 'text-gray-500 border-gray-700 bg-gray-800'
              }`}>
                {STATUS_LABEL[status]}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={popOut}
              className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
              title="Open in separate browser window"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
              title="Close chat"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {(status === 'connecting' || status === 'idle') && messages.length === 0 && (
            <div className="flex items-center justify-center h-24 text-gray-500 text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {status === 'connecting' ? 'Connecting to agent stream…' : 'No events yet.'}
            </div>
          )}
          {status === 'no-run' && (
            <div className="text-xs text-gray-500 text-center py-8">
              No agent activity yet — this session doesn't exist on the server
              (it may have been pruned or the server restarted).{' '}
              <button type="button" className="text-violet-400 hover:text-violet-300 underline" onClick={retry}>
                Check again
              </button>
            </div>
          )}
          {status === 'error' && messages.length === 0 && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-center">
              Couldn't reach the agent stream.{' '}
              <button type="button" className="underline hover:text-red-300" onClick={retry}>
                Retry
              </button>
            </div>
          )}
          {status !== 'no-run' && messages.length === 0 && status !== 'connecting' && status !== 'idle' && (
            <div className="text-xs text-gray-500 text-center py-8">
              No messages yet — the agent output will appear here once it starts working.
            </div>
          )}
          {messages.map((msg) =>
            msg.kind === 'tool' ? (
              <div key={msg.id} className="flex gap-2 justify-start">
                <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5 text-gray-400" />
                </div>
                <p className="text-[11px] text-gray-500 font-mono bg-gray-800/50 border border-gray-700/50 rounded-xl px-3 py-1.5">
                  <code className="text-gray-400">{msg.tool?.tool}</code>
                  {msg.tool?.summary && <span> {msg.tool.summary}</span>}
                  <span className="text-gray-600"> · {msg.tool?.status}</span>
                </p>
              </div>
            ) : msg.kind === 'error' ? (
              <div key={msg.id} className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 whitespace-pre-wrap break-words">
                {msg.markdown}
              </div>
            ) : (
              <div key={msg.id} className={`flex gap-2 ${msg.kind === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.kind !== 'user' && (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs break-words chat-markdown ${
                  msg.kind === 'user'
                    ? 'bg-violet-600/30 border border-violet-500/30 text-gray-100'
                    : 'bg-gray-800 border border-gray-700 text-gray-200'
                }`}>
                  <Markdown>{msg.markdown}</Markdown>
                </div>
                {msg.kind === 'user' && (
                  <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center shrink-0 mt-0.5">
                    <User className="w-3.5 h-3.5 text-gray-300" />
                  </div>
                )}
              </div>
            )
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        {sendError && (
          <div className="px-3 pt-2 text-[11px] text-red-400">{sendError}</div>
        )}
        <form onSubmit={handleSend} className="p-3 border-t border-gray-700/50 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Reply to agent…"
            className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="shrink-0 p-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 transition-all disabled:opacity-40"
            title="Send message"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
