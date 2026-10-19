import { useEffect, useRef, useState } from 'react';
import { Agent, OpenCodeModelInfo, Project, Task } from '../types';
import { sendPrompt, interruptSession, answerTool, fetchModels, getSessionInstruction } from '../api/opencode';
import { PREAMBLE_KEY } from '../prompts/boardAssistantPreamble';
import { ensureAssistantSession, clearAssistantSession, readAssistantSessionId, readAssistantAgentPref, readAssistantModelPref, saveAssistantPrefs } from '../store/assistantSession';
import { isModelAllowed } from '../store/modelResolution';
import { useSessionStream } from '../hooks/useSessionStream';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useAutoContinue } from '../hooks/useAutoContinue';
import { autoContinueMinToMs, hasUserHistory, readAutoContinueIdleMin, readAutoContinuePref, saveAutoContinuePref } from '../hooks/autoContinue';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow } from '../components/ChatFeed';
import { ChatMessage, chatToMarkdown } from '../components/chatEvents';
import FilePreviewModal from '../components/FilePreviewModal';
import { updateTask } from '../store/kanban';
import { ArrowLeft, Send, Loader2, Square, Mic, MicOff, Plus, Download, Check, RefreshCw } from 'lucide-react';

const WELCOME: ChatMessage = {
  id: 'welcome',
  kind: 'assistant',
  markdown:
    'Board assistant. Delegate work to a teammate from here. When the task turns done or blocked, its result queues back into this chat automatically.',
};

export default function MobileChat({
  task,
  project,
  availableAgents,
  onBack,
}: {
  task: Task | null;
  project: Project | null;
  availableAgents?: Agent[];
  onBack: () => void;
}) {
  const sessionId = task?.sessionId ?? null;
  const [assistantId, setAssistantId] = useState<string | null>(() =>
    project && !task ? readAssistantSessionId(project.id) : null,
  );
  const activeSessionId = sessionId ?? assistantId;
  const { messages, status, outcome, session, sessionError, retry } = useSessionStream(activeSessionId, {
    taskAgentName: task?.agentName ?? null,
  });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Desktop parity: keep Stop until the stream confirms the interrupt.
  const [interrupted, setInterrupted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const isAssistant = !task && !!project;
  // Desktop parity: agent + model pickers for the board assistant.
  const [selectedAgentId, setSelectedAgentId] = useState<string>(() =>
    isAssistant ? readAssistantAgentPref(project!.id) : '');
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    isAssistant ? readAssistantModelPref(project!.id, project) : '');
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const agents = availableAgents ?? [];
  const { listening: speechListening, transcribing: speechTranscribing, downloadPct: speechPct, speechError, toggle: toggleSpeech, clearSpeechError } = useSpeechInput();
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
    // Consistent with desktop and the server reconciler: report the real
    // session error when available, otherwise an honest placeholder.
    if (!task.resultContext && next === 'blocked') {
      patch.resultContext = sessionError
        ? `session outcome: ${outcome}; error: ${sessionError}`
        : `session outcome: ${outcome}; no error detail reported by the session`;
    }
    updateTask(task.id, patch as Partial<Task>).catch(() => {});
  }, [task?.id, task?.status, status, outcome]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  useEffect(() => {
    if (status === 'closed' || status === 'idle') setInterrupted(false);
  }, [status]);

  // Opt-in auto-continue (desktop parity). Assistant chats only — a task
  // chat is excluded by `isAssistant`. Same fixed prompt, same session.
  // busyAuto mirrors `busy` below; computed before the null guard because
  // useAutoContinue must run unconditionally.
  const busyAuto = status === 'live' || status === 'connecting' || sending || stopping || interrupted;
  const autoContinueIdleMin = readAutoContinueIdleMin();
  const [autoContinue, setAutoContinue] = useState<boolean>(() =>
    isAssistant ? readAutoContinuePref(project!.id) : false);
  const lastMsg = messages[messages.length - 1];
  const activityToken = lastMsg ? `${lastMsg.id}:${lastMsg.kind}:${status}` : `empty:${status}`;
  const sendAutoContinue = async (text: string): Promise<boolean> => {
    if (!activeSessionId) return false;
    const res = await sendPrompt(activeSessionId, text, selectedModel);
    if (!res.ok) {
      setSendError(`Auto-continue failed — ${res.error ?? 'unknown error'}`);
      return false;
    }
    setSendError(null);
    retry();
    return true;
  };
  useAutoContinue({
    enabled: autoContinue,
    isAssistant,
    sessionId: activeSessionId,
    status,
    busy: busyAuto,
    hasHistory: hasUserHistory(messages),
    activityToken,
    send: sendAutoContinue,
    idleMs: autoContinueMinToMs(autoContinueIdleMin),
  });
  const toggleAutoContinue = () => {
    if (!project) return;
    const next = !autoContinue;
    setAutoContinue(next);
    saveAutoContinuePref(project.id, next);
  };

  if (!task && !project) return null;

  const st = STATUS_DOT[status];
  const streamActive = status === 'live' || status === 'connecting';
  const busy = streamActive || sending || stopping || interrupted;

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const sessionAgent = (session as { agent?: unknown } | null)?.agent
    ? (typeof (session as { agent?: unknown }).agent === 'string'
      ? (session as { agent?: string }).agent
      : ((session as { agent?: { name?: string; id?: string } }).agent?.name || (session as { agent?: { id?: string } }).agent?.id))
    : undefined;
  const agentName = task?.agentName ?? selectedAgent?.name ?? sessionAgent ?? 'Board assistant';
  const modelHint = task?.modelProviderID && task?.modelId
    ? `${task.modelProviderID}/${task.modelId}`
    : task?.modelId ?? selectedModel ?? undefined;
  const msgCount = messages.length;
  const who = `${selectedAgent?.name || sessionAgent || 'assistant'} · ${selectedModel || 'server default'}`;

  const loadModels = async () => {
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  useEffect(() => {
    if (isAssistant) {
      setSelectedAgentId(readAssistantAgentPref(project!.id));
      setSelectedModel(readAssistantModelPref(project!.id, project));
      void loadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const filteredModels = models.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    if (!isModelAllowed(key, project?.allowedModels)) return false;
    const query = modelSearch.trim().toLowerCase();
    return !query || `${key} ${m.name ?? ''}`.toLowerCase().includes(query);
  });

  const handleStop = async () => {
    if (!activeSessionId || stopping) return;
    setStopping(true);
    const ok = await interruptSession(activeSessionId);
    setStopping(false);
    if (ok) {
      if (isAssistant) setInterrupted(true);
      retry();
    } else setSendError('Stop failed — the session may already be idle.');
  };

  // Desktop parity: changing agent/model resets the assistant session.
  const handleAgentChange = (v: string) => {
    if (!project) return;
    setSelectedAgentId(v);
    saveAssistantPrefs(project.id, v, selectedModel);
    if (activeSessionId) {
      clearAssistantSession(project.id);
      setAssistantId(null);
      setInterrupted(false);
      setSendError(null);
      setCreateError(null);
    }
  };

  const handleModelChange = (v: string) => {
    if (!project) return;
    setSelectedModel(v);
    saveAssistantPrefs(project.id, selectedAgentId, v);
    if (activeSessionId) {
      clearAssistantSession(project.id);
      setAssistantId(null);
      setInterrupted(false);
      setSendError(null);
      setCreateError(null);
    }
  };

  const handleNewChat = async () => {
    if (!project) return;
    if (activeSessionId && (status === 'live' || status === 'connecting')) {
      try { await interruptSession(activeSessionId); } catch { /* ignore */ }
    }
    clearAssistantSession(project.id);
    setAssistantId(null);
    setInterrupted(false);
    setInput('');
    setSendError(null);
    setCreateError(null);
  };

  const exportMarkdown = async () => {
    const title = task ? task.title : `Board assistant — ${project?.name ?? ''}`;
    // The board assistant's session prompt injection (instruction entry) is
    // not a chat message — fetch it so the export carries the preamble the
    // session ran under. Only assistant chats have it; task chats don't.
    const preamble = isAssistant && activeSessionId
      ? await getSessionInstruction(activeSessionId, PREAMBLE_KEY)
      : null;
    const md = chatToMarkdown(messages, { title, sessionId: activeSessionId, agentName, preamble: preamble ?? undefined });
    const name = `${isAssistant ? 'board-assistant' : 'task-chat'}-${(activeSessionId ?? 'no-session').slice(0, 12)}.md`;
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {
      try { void navigator.clipboard.writeText(md); } catch { /* ignore */ }
    }
    setExported(true); setTimeout(() => setExported(false), 1500);
  };

  const ensureSession = async (): Promise<string | null> => {
    if (activeSessionId) return activeSessionId;
    if (!project) return null;
    setCreating(true);
    setCreateError(null);
    if (isAssistant) saveAssistantPrefs(project.id, selectedAgentId, selectedModel);
    const res = await ensureAssistantSession(project, {
      agentId: isAssistant ? selectedAgentId : readAssistantAgentPref(project.id),
      model: isAssistant ? selectedModel : readAssistantModelPref(project.id, project),
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
    setInterrupted(false);
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
        gridTemplateRows: 'auto minmax(0, 1fr) 76px',
        overflow: 'hidden',
      }}
    >
      <header className="m-overlay-head" style={{ gridRow: 1, height: 'auto', minHeight: 56, overflow: 'visible', flexWrap: 'wrap', rowGap: 6 }}>
        <button className="m-icon-btn" onClick={onBack} aria-label="Back to board">
          <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <span className={`dot`} style={{ background: st.bg }} />
        <span className="m-overlay-title">{task ? task.title : project?.name}</span>
        <span className="pill p-neutral" style={{ fontSize: 10, padding: '2px 7px' }}>
          {agentName} · {activeSessionId ? st.label : creating ? 'creating…' : 'no session'}
        </span>
        {/* Desktop parity: new chat + export, same as AssistantChatWindow. */}
        <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button type="button" onClick={exportMarkdown} className="m-icon-btn" style={{ width: 36, height: 36 }} title="Export chat as Markdown" aria-label="Export chat as Markdown">
            {exported ? <Check className="w-4 h-4" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} /> : <Download className="w-4 h-4" strokeWidth={1.75} />}
          </button>
          {isAssistant && activeSessionId && (
            <button type="button" onClick={() => { void handleNewChat(); }} className="m-icon-btn" style={{ width: 36, height: 36 }} title="New assistant chat" aria-label="New assistant chat">
              <Plus className="w-4 h-4" strokeWidth={1.75} />
            </button>
          )}
        </span>
        {/* Desktop parity: agent + model pickers for the board assistant. */}
        {isAssistant && (
          <span style={{ display: 'flex', gap: 6, flexBasis: '100%', minWidth: 0 }}>
            <select
              value={selectedAgentId}
              onChange={(e) => handleAgentChange(e.target.value)}
              className="input mono"
              style={{ flex: '1 1 0', minWidth: 0, height: 36, minHeight: 36, fontSize: 11, padding: '4px 8px' }}
              title="Assistant agent — changing starts a new chat"
              aria-label="Assistant agent"
            >
              <option value="">Agent: default</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <span style={{ position: 'relative', flex: '1 1 0', minWidth: 0, display: 'flex', gap: 4 }}>
              <button
                type="button"
                onClick={() => { setModelSearch(''); setModelMenuOpen((open) => !open); }}
                className="input mono"
                style={{ flex: '1 1 0', minWidth: 0, height: 36, minHeight: 36, fontSize: 11, padding: '4px 8px', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title="Search and select an assistant model — changing starts a new chat"
              >
                {selectedModel || 'Model: default'}
              </button>
              <button type="button" onClick={() => { void loadModels(); }} disabled={modelsLoading} className="m-icon-btn" style={{ width: 36, height: 36 }} title="Refresh models" aria-label="Refresh models">
                <RefreshCw className={`w-4 h-4 muted ${modelsLoading ? 'animate-spin' : ''}`} />
              </button>
              {modelMenuOpen && (
                <span className="panel" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, padding: 6, zIndex: 50, width: 'min(420px, 90vw)', background: 'var(--surface)' }}>
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                    className="input mono"
                    style={{ width: '100%', height: 36, minHeight: 36, fontSize: 11, marginBottom: 6 }}
                  />
                  <span style={{ display: 'block', maxHeight: 240, overflowY: 'auto' }}>
                    <button type="button" onClick={() => { handleModelChange(''); setModelMenuOpen(false); }} className="block w-full text-left px-2.5 py-2 mono" style={{ fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' }}>Model: default</button>
                    {filteredModels.map((m, idx) => {
                      const key = `${m.providerID}/${m.modelID}`;
                      return (
                        <button type="button" key={`${key}__${idx}`} onClick={() => { handleModelChange(key); setModelMenuOpen(false); }} className="block w-full text-left px-2.5 py-2 mono" style={{ fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', marginTop: 4 }} title={m.name ? `${key} — ${m.name}` : key}>
                          <span className="block truncate"><span className="font-semibold">{key}</span>{m.name && <span style={{ color: 'var(--muted)' }}> — {m.name}</span>}</span>
                        </button>
                      );
                    })}
                    {filteredModels.length === 0 && <span className="muted mono" style={{ display: 'block', fontSize: 11, padding: '12px 8px', textAlign: 'center' }}>No models found.</span>}
                  </span>
                </span>
              )}
            </span>
          </span>
        )}
      </header>

      <div className="m-chat-feed" style={{ gridRow: 2, minHeight: 0, overflowY: 'auto' }}>
        {/* Opt-in auto-continue — same behavior as the desktop chat. */}
        {isAssistant && (
          <label
            className="flex items-center gap-2 px-3.5 py-2 border-b hairline cursor-pointer select-none"
            style={{ background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 1 }}
          >
            <input
              type="checkbox"
              checked={autoContinue}
              onChange={toggleAutoContinue}
              className="accent-violet-500 w-3.5 h-3.5"
              aria-label="Automatisch fortsetzen"
              title={`Sendet nach ${autoContinueIdleMin} Minuten ohne Aktivität eine Fortsetzung in dieselbe Session.`}
            />
            <span className="text-[11px] muted mono" title={`Sendet nach ${autoContinueIdleMin} Minuten ohne Aktivität eine Fortsetzung in dieselbe Session.`}>Automatisch fortsetzen</span>
          </label>
        )}
        {!task && <ChatBubble msg={{ ...WELCOME, markdown: isAssistant ? `Board assistant for ${project?.name ?? ''} (${who}). Ask about the board or delegate work. Finished tasks report back here.` : WELCOME.markdown }} agentName={agentName} modelName={modelHint} showAvatar onFileClick={setPreviewPath} />}
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
          if (msg.kind === 'tool') return <ToolRow key={msg.id} msg={msg} onFileClick={setPreviewPath} onAnswered={(id, out) => { if (!activeSessionId) { setSendError('No session — reconnect first.'); return; } void answerTool(activeSessionId, id, out).then((r) => { if (!r.ok) setSendError(`Could not send the answer — ${r.error ?? 'unknown error'}`); retry(); }); }} />;
          if (msg.kind === 'error') return <ChatErrorRow key={msg.id} msg={msg} detail={msg.id.endsWith('-outcome') ? sessionError : null} />;
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
          className="px-3 py-2 text-[11px] flex items-center gap-2"
          role="alert"
          style={{ position: 'absolute', right: 0, bottom: 76, left: 0, color: 'var(--amber)', background: 'var(--surface)' }}
        >
          <span className="flex-1">{speechError}</span>
          <button type="button" className="underline shrink-0" onClick={clearSpeechError} aria-label="Dismiss speech error">Dismiss</button>
        </div>
      )}

      <form className="m-chat-foot" style={{ gridRow: 3, height: 76, minHeight: 0, minWidth: 0, maxWidth: '100vw', overflow: 'hidden', alignItems: 'center' }} onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={speechTranscribing ? 'Transcribing locally…' : speechListening ? (speechPct != null && speechPct >= 0 ? `Loading voice model ${Math.min(100, Math.round(speechPct * 100))}%…` : 'Listening — speak now…') : busy ? 'Session running — Stop to interrupt…' : 'Reply to agent…'}
          className="input"
          style={{ height: 44, minHeight: 44, maxHeight: 44 }}
          disabled={busy || creating || (!activeSessionId && !project)}
        />
        {/* Mic always visible: on plain-http phones the mic API is
            missing, so toggle() shows the HTTPS hint instead of hiding. */}
        <button
          type="button"
          onClick={() => toggleSpeech((text) => setInput((prev) => (prev ? `${prev} ${text}` : text).slice(0, 4000)))}
          disabled={creating || (!activeSessionId && !project) || (busy && !speechListening)}
          className="m-chat-send"
          style={speechListening
            ? { background: 'var(--danger)', width: 44, height: 44, minHeight: 44, flexShrink: 0 }
            : { width: 44, height: 44, minHeight: 44, flexShrink: 0 }}
          aria-label={speechListening ? 'Stop speech input' : 'Use speech input'}
          aria-pressed={speechListening}
        >
          {speechListening ? <MicOff className="w-4 h-4" strokeWidth={1.75} /> : <Mic className="w-4 h-4" strokeWidth={1.75} />}
        </button>
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
