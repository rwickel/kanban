// Board assistant: own OpenCode session per project, no board task.
// Chat lives in its own session (like a task chat) but scoped to the project.
// No task is created on the board from this chat.
// Feed rendering reuses ChatFeed so styling + tool calls match SessionChatWindow.

import { useEffect, useRef, useState } from 'react';
import { X, Send, Loader2, Copy, Check, RefreshCw, Plus, Download, Square } from 'lucide-react';
import { Agent, OpenCodeModelInfo, Project } from '../types';
import { createSession, sendPrompt, interruptSession, fetchModels } from '../api/opencode';
import { useSessionStream } from '../hooks/useSessionStream';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow } from './ChatFeed';
import { chatToMarkdown, ChatMessage } from './chatEvents';
import FilePreviewModal from './FilePreviewModal';
import { getTaskModelPref } from '../store/serverConfig';

interface AssistantChatWindowProps {
  project: Project | null;
  availableAgents: Agent[];
  onClose: () => void;
}

const STORAGE_PREFIX = 'kanban_assistant_session_';
const AGENT_PREFIX = 'kanban_assistant_agent_';
const MODEL_PREFIX = 'kanban_assistant_model_';

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

export default function AssistantChatWindow({ project, availableAgents, onClose }: AssistantChatWindowProps) {
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (!project) return null;
    try { return localStorage.getItem(storageKey(project.id)); } catch { return null; }
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => {
    if (!project) return '';
    try { return localStorage.getItem(`${AGENT_PREFIX}${project.id}`) || ''; } catch { return ''; }
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (!project) return '';
    try {
      const stored = localStorage.getItem(`${MODEL_PREFIX}${project.id}`);
      if (stored) return stored;
      const pref = getTaskModelPref();
      return pref ? `${pref.providerID}/${pref.modelID}` : '';
    } catch { return ''; }
  });
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Keep Stop visible until the stream confirms the interrupt took effect,
  // otherwise the button vanishes before the session reports closed.
  const [interrupted, setInterrupted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem('kanban_chat_width');
      const n = raw ? Number(raw) : 400;
      return Number.isFinite(n) ? Math.min(800, Math.max(320, n)) : 400;
    } catch { return 400; }
  });
  const draggingRef = useRef(false);

  const { messages, status, session, retry } = useSessionStream(sessionId);

  useEffect(() => {
    if (!project) return;
    try {
      setSessionId(localStorage.getItem(storageKey(project.id)));
      setSelectedAgentId(localStorage.getItem(`${AGENT_PREFIX}${project.id}`) || '');
      const storedModel = localStorage.getItem(`${MODEL_PREFIX}${project.id}`);
      if (storedModel) setSelectedModel(storedModel);
    } catch { setSessionId(null); }
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const loadModels = async () => {
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (status === 'closed' || status === 'idle') setInterrupted(false);
  }, [status]);

  if (!project) return null;
  const st = STATUS_DOT[status];

  const busy = status === 'live' || status === 'connecting' || stopping || interrupted ||
    messages.some((m) => m.kind === 'tool' && m.tool && !['executed', 'completed', 'error'].includes((m.tool.status || '').toLowerCase()));

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
        const el = document.querySelector('[data-assistant-width]') as HTMLElement | null;
        const w = el ? el.getBoundingClientRect().width : startW;
        try { localStorage.setItem('kanban_chat_width', String(Math.round(w))); } catch {}
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const persistPrefs = (agentId?: string, model?: string) => {
    try {
      const a = agentId !== undefined ? agentId : selectedAgentId;
      const m = model !== undefined ? model : selectedModel;
      if (a) localStorage.setItem(`${AGENT_PREFIX}${project.id}`, a);
      else localStorage.removeItem(`${AGENT_PREFIX}${project.id}`);
      if (m) localStorage.setItem(`${MODEL_PREFIX}${project.id}`, m);
      else localStorage.removeItem(`${MODEL_PREFIX}${project.id}`);
    } catch {}
  };

  // Changing agent/model always works: with an active session it starts a
  // fresh chat so the next send uses the new picks (session pins them at create).
  const handleAgentChange = (v: string) => {
    setSelectedAgentId(v);
    persistPrefs(v, undefined);
    if (sessionId) {
      try { localStorage.removeItem(storageKey(project.id)); } catch {}
      setSessionId(null);
      setInterrupted(false);
      setSendError(null);
      setCreateError(null);
    }
  };

  const handleModelChange = (v: string) => {
    setSelectedModel(v);
    persistPrefs(undefined, v);
    if (sessionId) {
      try { localStorage.removeItem(storageKey(project.id)); } catch {}
      setSessionId(null);
      setInterrupted(false);
      setSendError(null);
      setCreateError(null);
    }
  };

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    setCreating(true);
    setCreateError(null);
    const directory = project.path?.trim() || undefined;
    const agent = selectedAgentId || undefined;
    const [providerID, ...rest] = (selectedModel || '').split('/');
    const modelID = rest.join('/');
    const model = providerID && modelID ? { providerID, id: modelID } : undefined;
    persistPrefs(selectedAgentId, selectedModel);
    const res = await createSession({ title: `Board assistant — ${project.name}`, agent, model, directory });
    setCreating(false);
    if (!res.session?.id) {
      setCreateError(res.error ?? 'Failed to create assistant session.');
      return null;
    }
    const id = res.session.id;
    setSessionId(id);
    try { localStorage.setItem(storageKey(project.id), id); } catch {}
    return id;
  };

  const handleNewChat = async () => {
    if (sessionId && (status === 'live' || status === 'connecting')) {
      try { await interruptSession(sessionId); } catch {}
    }
    try { localStorage.removeItem(storageKey(project.id)); } catch {}
    setSessionId(null);
    setInterrupted(false);
    setInput('');
    setSendError(null);
    setCreateError(null);
  };

  const handleClose = async () => {
    // Hide only: keep the stored session id so reopen resumes the same
    // chat. A fresh session starts only via "+" (handleNewChat).
    onClose();
  };

  const copySessionId = async () => {
    if (!sessionId) return;
    try { await navigator.clipboard.writeText(sessionId); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMarkdown = () => {
    const md = chatToMarkdown(messages, { title: `Board assistant — ${project.name}`, sessionId, agentName: selectedAgent?.name });
    const name = `board-assistant-${(sessionId ?? 'no-session').slice(0, 12)}.md`;
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch {
      try { navigator.clipboard.writeText(md); } catch { /* ignore */ }
    }
    setExported(true); setTimeout(() => setExported(false), 1500);
  };

  const handleStop = async () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    setSendError(null);
    const ok = await interruptSession(sessionId);
    setStopping(false);
    if (ok) {
      setInterrupted(true);
      retry();
    }
    else setSendError('Stop failed — session may already be idle.');
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setInterrupted(false);
    setSending(true);
    setSendError(null);
    const sid = await ensureSession();
    if (!sid) { setSending(false); return; }
    const res = await sendPrompt(sid, text);
    setSending(false);
    if (res.ok) {
      setInput('');
      retry();
    } else {
      setSendError(`Failed to send — ${res.error ?? 'unknown error'}`);
    }
  };

  const selectedAgent = availableAgents.find((a) => a.id === selectedAgentId);
  const sessionAgent = (session as any)?.agent
    ? (typeof (session as any).agent === 'string' ? (session as any).agent : (session as any).agent?.name || (session as any).agent?.id)
    : undefined;
  const agentName = selectedAgent?.name || sessionAgent || 'Board assistant';
  const modelHint = selectedModel || undefined;
  const msgCount = messages.length;
  const welcomeMsg: ChatMessage = {
    id: 'welcome',
    kind: 'assistant',
    markdown: `Hi, I am your board assistant for ${project.name} (${selectedAgent?.name || sessionAgent || 'assistant'} · ${selectedModel || 'server default'}). Ask anything about this project. This chat stays in its own session — no task is created on the board.`,
  };

  return (
    <div className="fixed top-3 right-3 bottom-3 z-50 flex justify-end pointer-events-none">
      <div data-assistant-width className="relative h-full flex flex-col shrink-0 pointer-events-auto panel overflow-hidden" style={{ width, maxWidth: '90vw', borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div onPointerDown={onHandlePointerDown} title="Drag to resize"
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />
        <div className="modal-head px-3.5 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`dot ${st.pulse ? 'animate-pulse' : ''}`} style={{ background: st.bg }} />
                <p className="text-[11px] uppercase tracking-widest font-semibold t-strong mono truncate">{agentName}</p>
                <span className="text-[10px] muted mono">· {sessionId ? st.label : 'no session yet'}{msgCount > 0 ? ` · ${msgCount}` : ''}</span>
              </div>
              <h2 className="text-[13px] font-semibold t-strong truncate">{project.name}</h2>
              {sessionId ? (
                <button onClick={copySessionId} title="Copy session id" className="pill p-neutral mt-1.5 max-w-full">
                  <span className="truncate">{sessionId}</span>
                  {copied ? <Check className="w-3 h-3" strokeWidth={1.75} /> : <Copy className="w-3 h-3" strokeWidth={1.75} />}
                </button>
              ) : (
                <p className="text-[10px] muted mono mt-1">Pick agent + model, then ask.</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={exportMarkdown} className="btn p-1.5" title="Export chat as Markdown">
                {exported ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />}
              </button>
              {sessionId && (
                <button onClick={handleNewChat} className="btn p-1.5" title="New assistant chat"><Plus className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
              )}
              <button onClick={handleClose} className="btn p-1.5" title="Close — chat stays, reopen resumes"><X className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
            </div>
          </div>
          {/* Agent + model pickers — changing resets session so next send uses new picks */}
          <div className="grid grid-cols-2 gap-1.5 mt-2">
            <select
              value={selectedAgentId}
              onChange={(e) => handleAgentChange(e.target.value)}
              className="input mono text-[11px] py-1.5"
              title="Assistant agent — changing starts a new chat"
            >
              <option value="">Agent: default</option>
              {availableAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <div className="flex gap-1">
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="input mono text-[11px] py-1.5 flex-1 min-w-0"
                title="Assistant model — changing starts a new chat"
              >
                <option value="">Model: default</option>
                {models.map((m, idx) => {
                  const key = `${m.providerID}/${m.modelID}`;
                  return <option key={`${key}__${idx}`} value={key}>{key}</option>;
                })}
              </select>
              <button type="button" onClick={loadModels} disabled={modelsLoading} className="btn p-1.5 shrink-0" title="Refresh models">
                <RefreshCw className={`w-3 h-3 muted ${modelsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3.5 space-y-3" style={{ background: 'var(--bg)' }}>
          {/* Welcome message — same bubble styling as task chat */}
          <ChatBubble msg={welcomeMsg} agentName={agentName} modelName={modelHint} showAvatar onFileClick={(p) => setPreviewPath(p)} />
          {(status === 'connecting' || status === 'idle') && msgCount === 0 && sessionId && (
            <div className="flex flex-col items-center justify-center h-20 gap-2 muted">
              <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
              <p className="text-[12px]">{status === 'connecting' ? 'Connecting…' : 'No events yet.'}</p>
            </div>
          )}
          {status === 'no-run' && sessionId && (
            <div className="text-[12px] muted text-center py-8">
              No agent activity yet.{' '}<button type="button" className="underline t-strong" onClick={retry}>Check again</button>
            </div>
          )}
          {status === 'error' && msgCount === 0 && sessionId && (
            <div className="text-[12px] p-3 text-center panel" style={{ color: 'var(--danger)' }}>
              Couldn't reach the stream.{' '}<button type="button" className="underline" onClick={retry}>Retry</button>
            </div>
          )}
          {creating && (
            <div className="flex gap-2 items-center text-[11px] muted mono"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating assistant session…</div>
          )}
          {createError && (
            <div className="text-[11px] panel p-2" style={{ color: 'var(--danger)' }}>{createError}</div>
          )}
          {messages.map((msg, idx) => {
            const prev = idx > 0 ? messages[idx - 1] : undefined;
            const startsTurn = msg.kind !== 'user' && (!prev || prev.kind === 'user');
            if (msg.kind === 'tool') return <ToolRow key={msg.id} msg={msg} onFileClick={(p) => setPreviewPath(p)} />;
            if (msg.kind === 'error') return <ChatErrorRow key={msg.id} msg={msg} />;
            if (msg.kind === 'reasoning') return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={agentName} modelName={modelHint} onFileClick={(p) => setPreviewPath(p)} />;
            return <ChatBubble key={msg.id} msg={msg} agentName={msg.kind === 'user' ? undefined : agentName} modelName={msg.kind === 'user' ? undefined : modelHint} showAvatar={msg.kind === 'user' ? true : startsTurn} onFileClick={(p) => setPreviewPath(p)} />;
          })}
          <div ref={bottomRef} />
          {busy && msgCount > 0 && (
            <div className="flex gap-2 justify-start items-center animate-fadeIn">
              <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin muted" strokeWidth={1.75} />
              </div>
              <p className="text-[11px] muted mono">Assistant running…</p>
            </div>
          )}
        </div>

        {sendError && <div className="px-3.5 pt-2 text-[11px]" style={{ color: 'var(--danger)' }}>{sendError}</div>}
        <form onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend} className="p-3 border-t hairline" style={{ borderTopWidth: 1, borderTopStyle: 'solid', background: 'var(--surface)' }}>
          <div className="flex gap-1.5 items-end">
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder={busy ? 'Assistant running — Stop to interrupt…' : 'Ask the board assistant…  (↵ send)'} className="input" disabled={busy || creating} autoFocus />
            {busy ? (
              <button type="submit" disabled={stopping || !sessionId} className="btn p-2 shrink-0" title="Stop running session" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {stopping ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Square className="w-4 h-4" strokeWidth={1.75} />}
              </button>
            ) : (
              <button type="submit" disabled={!input.trim() || sending || creating} className="btn btn-primary p-2 shrink-0" title="Send">
                {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Send className="w-4 h-4" strokeWidth={1.75} />}
              </button>
            )}
          </div>
        </form>
      </div>
      {previewPath && <FilePreviewModal absPath={previewPath} onClose={() => setPreviewPath(null)} />}
    </div>
  );
}
