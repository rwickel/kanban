import { useEffect, useRef, useState } from 'react';
import { Project, Task } from '../types';
import { sendPrompt, interruptSession, answerTool } from '../api/opencode';
import { ensureAssistantSession, readAssistantSessionId, readAssistantAgentPref, readAssistantModelPref } from '../store/assistantSession';
import { useSessionStream } from '../hooks/useSessionStream';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow } from '../components/ChatFeed';
import { ChatMessage } from '../components/chatEvents';
import FilePreviewModal from '../components/FilePreviewModal';
import { updateTask } from '../store/kanban';
import { ArrowLeft, Send, Loader2, Square, Mic, MicOff } from 'lucide-react';

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
  const [assistantId, setAssistantId] = useState<string | null>(() =>
    project && !task ? readAssistantSessionId(project.id) : null,
  );
  const activeSessionId = sessionId ?? assistantId;
  const { messages, status, outcome, retry } = useSessionStream(activeSessionId, {
    taskAgentName: task?.agentName ?? null,
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const { supported: speechSupported, listening: speechListening, speechError, toggle: toggleSpeech } = useSpeechInput();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (task || !project) return;
    setAssistantId(readAssistantSessionId(project.id));
  }, [task, project?.id]);

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
    if (!activeSessionId || stopping) return;
    setStopping(true);
    const ok = await interruptSession(activeSessionId);
    setStopping(false);
    if (ok) retry();
    else setSendError('Stop failed — the session may already be idle.');
  };

  const ensureSession = async (): Promise<string | null> => {
    if (activeSessionId) return activeSessionId;
    if (!project) return null;
    setCreating(true);
    setCreateError(null);
    const res = await ensureAssistantSession(project, {
      agentId: readAssistantAgentPref(project.id),
      model: readAssistantModelPref(project.id),
    });
    setCreating(false);
    if (!res.id) {
      setCreateError(res.error ?? 'Failed to create assistant session.');
      return null;
    }
    setAssistantId(res.id);
    return res.id;
  };

  useEffect(() => {
    if (task || !project || activeSessionId) return;
    void ensureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, project?.id, activeSessionId]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    const sid = await ensureSession();
    if (!sid) { setSending(false); return; }
    const res = await sendPrompt(sid, text, task?.agentId ?? task?.agentName);
    setSending(false);
    if (res.ok) {
      setInput('');
      retry();
    } else {
      setSendError(`Failed to send — ${res.error ?? 'unknown error'}`);
    }
  };

  return (
    <div
      className="m-full is-chat"
      style={{
        position: 'fixed',
        inset: 0,
        width: 'auto',
        height: 'auto',
        display: 'grid',
        gridTemplateRows: '56px minmax(0, 1fr) 76px',
        overflow: 'hidden',
      }}
    >
      <header className="m-overlay-head" style={{ gridRow: 1, height: 56, minHeight: 0, overflow: 'hidden' }}>
        <button className="m-icon-btn" onClick={onBack} aria-label="Back to board">
          <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <span className={`dot`} style={{ background: st.bg }} />
        <span className="m-overlay-title">{task ? task.title : project?.name}</span>
        <span className="pill p-neutral" style={{ fontSize: 10, padding: '2px 7px' }}>
          {agentName} · {activeSessionId ? st.label : creating ? 'creating…' : 'no session'}
        </span>
      </header>

      <div className="m-chat-feed" style={{ gridRow: 2, minHeight: 0, overflowY: 'auto' }}>
        {!task && <ChatBubble msg={WELCOME} agentName={agentName} modelName={modelHint} showAvatar onFileClick={setPreviewPath} />}
        {(status === 'connecting' || status === 'idle') && messages.length === 0 && activeSessionId && (
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
        {creating && messages.length === 0 && !activeSessionId && (
          <div className="muted" style={{ textAlign: 'center', fontSize: 12 }}>
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> Creating assistant session…
          </div>
        )}
        {createError && messages.length === 0 && !activeSessionId && (
          <div className="m-readonly" style={{ color: 'var(--danger)', textAlign: 'center' }}>
            {createError}
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

      {sendError && (
        <div
          className="px-3 py-2 text-[11px]"
          style={{ position: 'absolute', right: 0, bottom: 76, left: 0, color: 'var(--danger)', background: 'var(--surface)' }}
        >
          {sendError}
        </div>
      )}

      {speechError && (
        <div
          className="px-3 py-2 text-[11px]"
          style={{ position: 'absolute', right: 0, bottom: 76, left: 0, color: 'var(--amber)', background: 'var(--surface)' }}
        >
          {speechError}
        </div>
      )}

      <form className="m-chat-foot" style={{ gridRow: 3, height: 76, minHeight: 0, overflow: 'hidden', alignItems: 'center' }} onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={speechListening ? 'Listening — speak now…' : busy ? 'Session running — Stop to interrupt…' : 'Reply to agent…'}
          className="input"
          style={{ height: 44, minHeight: 44, maxHeight: 44 }}
          disabled={busy || creating || (!activeSessionId && !project)}
        />
        {speechSupported && !busy && (
          <button
            type="button"
            onClick={() => toggleSpeech((text) => setInput((prev) => (prev ? `${prev} ${text}` : text).slice(0, 4000)))}
            disabled={creating || (!activeSessionId && !project)}
            className="m-chat-send"
            style={speechListening
              ? { background: 'var(--danger)', width: 44, height: 44, minHeight: 44, flexShrink: 0 }
              : { width: 44, height: 44, minHeight: 44, flexShrink: 0 }}
            aria-label={speechListening ? 'Stop speech input' : 'Use speech input'}
            aria-pressed={speechListening}
          >
            {speechListening ? <MicOff className="w-4 h-4" strokeWidth={1.75} /> : <Mic className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        )}
        {busy ? (
          <button type="submit" disabled={stopping || !activeSessionId} className="m-chat-send" style={{ background: 'var(--danger)', width: 44, height: 44, minHeight: 44, flexShrink: 0 }} aria-label="Stop session">
            {stopping ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Square className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || sending || creating || (!activeSessionId && !project)} className="m-chat-send" style={{ width: 44, height: 44, minHeight: 44, flexShrink: 0 }} aria-label="Send">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Send className="w-4 h-4" strokeWidth={1.75} />}
          </button>
        )}
      </form>

      {previewPath && <FilePreviewModal absPath={previewPath} onClose={() => setPreviewPath(null)} />}
    </div>
  );
}
