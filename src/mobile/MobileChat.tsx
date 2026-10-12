import { useEffect, useRef, useState } from 'react';
import { Project, Task } from '../types';
import { sendPrompt, interruptSession } from '../api/opencode';
import { useSessionStream } from '../hooks/useSessionStream';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow } from '../components/ChatFeed';
import { ChatMessage } from '../components/chatEvents';
import FilePreviewModal from '../components/FilePreviewModal';
import { updateTask } from '../store/kanban';
import { ArrowLeft, Send, Loader2, Square } from 'lucide-react';

const WELCOME: ChatMessage = {
  id: 'welcome',
  kind: 'assistant',
  markdown:
    'Board assistant. Delegate work to a teammate from here. When the task turns done or blocked, its result queues back into this chat automatically.',
};

export default function MobileChat({
  task,
  project,
  onBack,
}: {
  task: Task | null;
  project: Project | null;
  onBack: () => void;
}) {
  const sessionId = task?.sessionId ?? null;
  const { messages, status, outcome, retry } = useSessionStream(sessionId, {
    taskAgentName: task?.agentName ?? null,
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Session finished → board column follows: failed/error → blocked,
  // completed/done → done. Result = last assistant message.
  const lastResultRef = useRef('');
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.kind === 'assistant' && m.markdown.trim());
    if (last) lastResultRef.current = last.markdown.trim().slice(0, 4000);
  }, [messages]);
  useEffect(() => {
    if (!task || task.status !== 'running' || status !== 'closed' || !outcome) return;
    const o = outcome.toLowerCase();
    const next = ['failed', 'error'].includes(o)
      ? 'blocked'
      : ['completed', 'done'].includes(o)
        ? 'done'
        : null;
    if (!next) return;
    const patch: Record<string, unknown> = { status: next };
    if (!task.result && lastResultRef.current) patch.result = lastResultRef.current;
    if (!task.resultContext && next === 'blocked') patch.resultContext = `session outcome: ${outcome}`;
    updateTask(task.id, patch as Partial<Task>).catch(() => {});
  }, [task?.id, task?.status, status, outcome]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  if (!task && !project) return null;

  const st = STATUS_DOT[status];
  const streamActive = status === 'live' || status === 'connecting';
  const busy = streamActive || stopping;
  const agentName = task?.agentName ?? 'Board assistant';
  const modelHint = task?.modelProviderID && task?.modelId
    ? `${task.modelProviderID}/${task.modelId}`
    : task?.modelId ?? undefined;

  const handleStop = async () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    const ok = await interruptSession(sessionId);
    setStopping(false);
    if (ok) retry();
    else setSendError('Stop failed — the session may already be idle.');
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || !sessionId || sending) return;
    setSending(true);
    setSendError(null);
    const res = await sendPrompt(sessionId, text, task?.agentId ?? task?.agentName);
    setSending(false);
    if (res.ok) {
      setInput('');
      retry();
    } else {
      setSendError(`Failed to send — ${res.error ?? 'unknown error'}`);
    }
  };

  return (
    <div className="m-full is-chat">
      <header className="m-overlay-head">
        <button className="m-icon-btn" onClick={onBack} aria-label="Back to board">
          <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <span className={`dot`} style={{ background: st.bg }} />
        <span className="m-overlay-title">{task ? task.title : project?.name}</span>
        <span className="pill p-neutral" style={{ fontSize: 10, padding: '2px 7px' }}>
          {agentName} · {sessionId ? st.label : 'no session'}
        </span>
      </header>

      <div className="m-chat-feed">
        {!task && <ChatBubble msg={WELCOME} agentName={agentName} modelName={modelHint} showAvatar onFileClick={setPreviewPath} />}
        {(status === 'connecting' || status === 'idle') && messages.length === 0 && sessionId && (
          <div className="muted" style={{ textAlign: 'center', fontSize: 12 }}>
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> Connecting…
          </div>
        )}
        {status === 'no-run' && (
          <div className="muted" style={{ textAlign: 'center', fontSize: 12 }}>
            No agent activity yet.{' '}
            <button type="button" className="underline t-strong" onClick={retry}>Check again</button>
          </div>
        )}
        {status === 'error' && messages.length === 0 && (
          <div className="m-readonly" style={{ color: 'var(--danger)', textAlign: 'center' }}>
            Could not reach the stream.{' '}
            <button type="button" className="underline" onClick={retry}>Retry</button>
          </div>
        )}
        {messages.map((msg, idx) => {
          const prev = idx > 0 ? messages[idx - 1] : undefined;
          const startsTurn = msg.kind !== 'user' && (!prev || prev.kind === 'user');
          if (msg.kind === 'tool') return <ToolRow key={msg.id} msg={msg} onFileClick={setPreviewPath} />;
          if (msg.kind === 'error') return <ChatErrorRow key={msg.id} msg={msg} />;
          if (msg.kind === 'reasoning') {
            return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={agentName} modelName={modelHint} onFileClick={setPreviewPath} />;
          }
          return (
            <ChatBubble
              key={msg.id}
              msg={msg}
              agentName={msg.kind === 'user' ? undefined : agentName}
              modelName={msg.kind === 'user' ? undefined : modelHint}
              showAvatar={msg.kind === 'user' ? true : startsTurn}
              onFileClick={setPreviewPath}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {sendError && <div className="px-3 pt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{sendError}</div>}

      <form className="m-chat-foot" onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Session running — Stop to interrupt…' : 'Reply to agent…'}
          className="input"
          disabled={busy || !sessionId}
        />
        {busy ? (
          <button type="submit" disabled={stopping || !sessionId} className="m-chat-send" style={{ background: 'var(--danger)' }} aria-label="Stop session">
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Square className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || sending || !sessionId} className="m-chat-send" aria-label="Send">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Send className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        )}
      </form>

      {previewPath && <FilePreviewModal absPath={previewPath} onClose={() => setPreviewPath(null)} />}
    </div>
  );
}