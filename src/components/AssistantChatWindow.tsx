// Board assistant: own OpenCode session per project, no board task.
// Chat lives in its own session (like a task chat) but scoped to the project.
// No task is created on the board from this chat.
// Feed rendering reuses ChatFeed so styling + tool calls match SessionChatWindow.

import { useEffect, useRef, useState } from 'react';
import { X, Send, Loader2, Copy, Check, RefreshCw, Plus, Download, Square, Mic, MicOff, ExternalLink } from 'lucide-react';
import { Agent, OpenCodeModelInfo, Project } from '../types';
import { answerTool, createSession, sendPrompt, forkSession, switchSessionAgent, switchSessionModel, interruptSession, fetchModels, getSessionInstruction } from '../api/opencode';
import { PREAMBLE_KEY } from '../prompts/boardAssistantPreamble';
import { useSessionStream } from '../hooks/useSessionStream';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useChatSize, CHAT_EDGE_GAP } from '../hooks/useChatSize';
import { useAutoContinue } from '../hooks/useAutoContinue';
import { autoContinueMinToMs, hasUserHistory, readAutoContinueIdleMin, readAutoContinuePref, saveAutoContinuePref } from '../hooks/autoContinue';
import { STATUS_DOT, ThinkingBlock, ToolRow, ChatBubble, ChatErrorRow, ReviewTarget } from './ChatFeed';
import { chatToMarkdown, ChatMessage } from './chatEvents';
import FilePreviewModal from './FilePreviewModal';
import ChatExportModal from './ChatExportModal';
import {
  clearAssistantSession,
  ensureAssistantSession,
  readAssistantAgentPref,
  readAssistantModelPref,
  readAssistantSessionId,
  saveAssistantSessionId,
  saveAssistantPrefs,
} from '../store/assistantSession';
import { isModelAllowed } from '../store/modelResolution';
import { createTask } from '../store/kanban';

interface AssistantChatWindowProps {
  project: Project | null;
  availableAgents: Agent[];
  onClose: () => void;
  onTaskClick?: (kind: 'task' | 'session', id: string) => void;
  standalone?: boolean;
}

/** How much of the floating panel must stay reachable when it is dragged. */
const MIN_ONSCREEN = 120;

export default function AssistantChatWindow({ project, availableAgents, onClose, onTaskClick, standalone = false }: AssistantChatWindowProps) {
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (!project) return null;
    return readAssistantSessionId(project.id);
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => {
    if (!project) return '';
    return readAssistantAgentPref(project.id);
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (!project) return '';
    return readAssistantModelPref(project.id, project);
  });
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Keep Stop visible until the stream confirms the interrupt took effect,
  // otherwise the button vanishes before the session reports closed.
  const [interrupted, setInterrupted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // The session prompt injection (instruction entry) is not a chat message,
  // so it must be fetched when the export opens — otherwise the exported
  // markdown would miss the preamble the session ran under.
  const [exportPreamble, setExportPreamble] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  // Opt-in auto-continue: default OFF. Persisted per project so desktop and
  // mobile stay in sync. The 5-minute idle timer sends one fixed prompt into
  // the SAME session — no new session, no board task.
  const [autoContinue, setAutoContinue] = useState<boolean>(() =>
    project ? readAutoContinuePref(project.id) : false,
  );
  const { supported: speechSupported, listening: speechListening, transcribing: speechTranscribing, downloadPct: speechPct, speechError, toggle: toggleSpeech } = useSpeechInput();
  const bottomRef = useRef<HTMLDivElement>(null);
  const { width, height, startResize } = useChatSize(400);
  // `position` is an offset measured inward from the right/bottom viewport
  // edges. Positive moves the panel away from those edges, negative slides it
  // partly under them — a full-height panel still has to be movable, so the
  // range is not limited to the positive free space. At least this much of the
  // panel always stays reachable on screen.
  const [position, setPosition] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kanban_assistant_position_v2') || '{"x":0,"y":0}') as { x: number; y: number }; } catch { return { x: 0, y: 0 }; }
  });

  const clampPosition = (p: { x: number; y: number }, w: number, h: number) => ({
    x: Math.min(Math.max(MIN_ONSCREEN - w, p.x), Math.max(0, window.innerWidth - w - CHAT_EDGE_GAP * 2)),
    y: Math.min(Math.max(MIN_ONSCREEN - h, p.y), Math.max(0, window.innerHeight - h - CHAT_EDGE_GAP * 2)),
  });

  // Re-clamp when the panel is resized or the viewport shrinks; persist the
  // result so a reload restores a reachable position.
  useEffect(() => {
    setPosition((p) => {
      const next = clampPosition(p, width, height);
      if (next.x === p.x && next.y === p.y) return p;
      try { localStorage.setItem('kanban_assistant_position_v2', JSON.stringify(next)); } catch {}
      return next;
    });
  }, [width, height]);

  // Drag the panel by its header. The anchor is derived from the panel's actual
  // right/bottom edges instead of a raw delta: adding the pointer delta to the
  // offset would send the panel the opposite way.
  const onWindowPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) return;
    // Distance from the pointer to the panel's right/bottom edges, constant
    // for the whole drag.
    const grabRight = e.clientX - (window.innerWidth - CHAT_EDGE_GAP - position.x);
    const grabBottom = e.clientY - (window.innerHeight - CHAT_EDGE_GAP - position.y);
    const move = (ev: PointerEvent) => {
      const x = window.innerWidth - CHAT_EDGE_GAP - (ev.clientX - grabRight);
      const y = window.innerHeight - CHAT_EDGE_GAP - (ev.clientY - grabBottom);
      setPosition(clampPosition({ x, y }, width, height));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPosition((p) => { try { localStorage.setItem('kanban_assistant_position_v2', JSON.stringify(p)); } catch {} return p; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const { messages, status, session, sessionError, retry } = useSessionStream(sessionId);

  // "Busy" means the composer is locked. Mirrors the busy used by the send
  // form below; computed early so the auto-continue hook can read it.
  const streamActiveEarly = status === 'live' || status === 'connecting';
  const busyEarly = streamActiveEarly || sending || stopping || interrupted;

  // Keep auto-continue pref in sync when the project changes.
  useEffect(() => {
    if (!project) return;
    setAutoContinue(readAutoContinuePref(project.id));
  }, [project?.id]);

  const toggleAutoContinue = () => {
    if (!project) return;
    const next = !autoContinue;
    setAutoContinue(next);
    saveAutoContinuePref(project.id, next);
  };

  // Board-assistant only. The last message id + status form the activity
  // token; every new visible activity restarts the idle window. The idle
  // time itself is configurable on the Settings page (default 5 minutes).
  const isAssistantChat = true;
  const autoContinueIdleMin = readAutoContinueIdleMin();
  const lastMsg = messages[messages.length - 1];
  const activityToken = lastMsg ? `${lastMsg.id}:${lastMsg.kind}:${status}` : `empty:${status}`;
  const sendAutoContinue = async (text: string): Promise<boolean> => {
    if (!sessionId) return false;
    const res = await sendPrompt(sessionId, text, selectedModel);
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
    isAssistant: isAssistantChat,
    sessionId,
    status,
    busy: busyEarly,
    hasHistory: hasUserHistory(messages),
    activityToken,
    send: sendAutoContinue,
    idleMs: autoContinueMinToMs(autoContinueIdleMin),
  });

  useEffect(() => {
    if (!project) return;
    setSessionId(readAssistantSessionId(project.id));
    setSelectedAgentId(readAssistantAgentPref(project.id));
    setSelectedModel(readAssistantModelPref(project.id, project));
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const loadModels = async () => {
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  const filteredModels = models.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    if (!isModelAllowed(key, project?.allowedModels)) return false;
    const query = modelSearch.trim().toLowerCase();
    return !query || `${key} ${m.name ?? ''}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (status === 'closed' || status === 'idle') setInterrupted(false);
  }, [status]);

  // "Busy" means the composer is locked. Only a genuinely live stream
  // should do that — a stale tool row must not lock the input forever.
  const streamActive = status === 'live' || status === 'connecting';
  const busy = streamActive || sending || stopping || interrupted;

  // Agent changes start a fresh session because the session owns its agent.
  // Save the pref only after the switch succeeds — otherwise a failed
  // switch leaves a stale pref and reload shows the wrong agent.
  const handleAgentChange = async (v: string) => {
    const prev = selectedAgentId;
    setSelectedAgentId(v);
    if (sessionId) {
      const switched = v ? await switchSessionAgent(sessionId, v) : false;
      if (!switched && v) {
        setSelectedAgentId(prev);
        setSendError('Agent switch failed — the current session kept its previous agent.');
        return;
      }
    }
    saveAssistantPrefs(project.id, v, selectedModel);
  };

  const handleModelChange = async (v: string) => {
    const prev = selectedModel;
    setSelectedModel(v);
    if (sessionId && v) {
      const switched = await switchSessionModel(sessionId, v);
      if (!switched) {
        setSelectedModel(prev);
        setSendError('Model switch failed — the current session kept its previous model.');
        return;
      }
    }
    saveAssistantPrefs(project.id, selectedAgentId, v);
  };

  // Reconcile the dropdowns with the session's actual agent/model.
  // The selections initialize from localStorage prefs, which go stale when
  // the session was switched elsewhere (another tab/client) or a switch
  // failed. The session is the source of truth — adopt it and persist it.
  useEffect(() => {
    if (!project || !session) return;
    const m = (session as Record<string, unknown>).model as
      | string
      | { providerID?: string; modelID?: string; id?: string }
      | undefined;
    const actualModel =
      typeof m === 'string'
        ? m
        : m && (m.providerID || (m as Record<string, unknown>).provider)
          ? `${m.providerID ?? (m as Record<string, unknown>).provider as string}/${m.modelID ?? m.id ?? ''}`.replace(/\/$/, '')
          : '';
    if (actualModel && actualModel !== selectedModel) setSelectedModel(actualModel);
    const actualAgent = typeof (session as Record<string, unknown>).agent === 'string'
      ? ((session as Record<string, unknown>).agent as string)
      : '';
    if (actualAgent && actualAgent !== selectedAgentId) setSelectedAgentId(actualAgent);
    if ((actualModel && actualModel !== selectedModel) || (actualAgent && actualAgent !== selectedAgentId)) {
      saveAssistantPrefs(project.id, actualAgent || selectedAgentId, actualModel || selectedModel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, JSON.stringify((session as Record<string, unknown> | null)?.model ?? null), (session as Record<string, unknown> | null)?.agent]);

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    setCreating(true);
    setCreateError(null);
    saveAssistantPrefs(project.id, selectedAgentId, selectedModel);
    const res = await ensureAssistantSession(project, { agentId: selectedAgentId, model: selectedModel });
    setCreating(false);
    if (!res.id) {
      setCreateError(res.error ?? 'Failed to create assistant session.');
      return null;
    }
    setSessionId(res.id);
    return res.id;
  };

  // Open the chat → create the session right away so the id is visible in
  // the header and can be passed as parentSessionId on the first message.
  useEffect(() => {
    if (!project || sessionId) return;
    void ensureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, sessionId, selectedAgentId, selectedModel]);

  if (!project) return null;
  const st = STATUS_DOT[status];

  const handleNewChat = async () => {
    if (sessionId && (status === 'live' || status === 'connecting')) {
      try { await interruptSession(sessionId); } catch {}
    }
    clearAssistantSession(project.id);
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

  const popOut = () => {
    window.open(`${window.location.pathname}#assistant/${encodeURIComponent(project.id)}`, '_blank', 'popup=yes,width=480,height=720,toolbar=no,location=no,menubar=no,status=no');
  };

  const copySessionId = async () => {
    if (!sessionId) return;
    try { await navigator.clipboard.writeText(sessionId); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMarkdown = async () => {
    // Fresh read on every open: the entry can be re-pushed on attach or
    // agent/model change, so a cached copy could be stale. A failed read
    // (server down) still exports the chat — just without the preamble.
    const preamble = sessionId ? await getSessionInstruction(sessionId, PREAMBLE_KEY) : null;
    setExportPreamble(preamble);
    setExportOpen(true);
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
    else { retry(); setSendError('Stop failed — session may already be idle.'); }
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending || !project) return;
    setInterrupted(false);
    setSending(true);
    setSendError(null);
    const sid = await ensureSession();
    if (!sid) { setSending(false); return; }
    const fork = editingMessageId ? await forkSession(sid, editingMessageId) : { ok: true, sessionId: sid };
    if (fork.ok && fork.sessionId && editingMessageId) {
      setSessionId(fork.sessionId);
      saveAssistantSessionId(project.id, fork.sessionId);
    }
    const res = fork.ok && fork.sessionId ? await sendPrompt(fork.sessionId, text, selectedModel) : { ok: false, error: fork.error ?? 'Could not create edited conversation' };
    setSending(false);
    if (res.ok) {
      setInput('');
      setEditingMessageId(null);
      retry();
    } else {
      setSendError(`Failed to send — ${res.error ?? 'unknown error'}`);
    }
  };

  const handleReview = async (target: ReviewTarget) => {
    if (!project || !sessionId || reviewing) return;
    setReviewing(target.messageId);
    try {
      const response = await fetch('/api/kanban/delegate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, title: `Review: ${target.kind} ${target.messageId.slice(0, 12)}`, agentId: 'code-reviewer', agentName: 'Code Reviewer', priority: 'medium', parentSessionId: sessionId, description: `Review session ${sessionId}, message ${target.messageId}. Return simple Pros and Cons. For every con explain why it is bad, what is expected, and the likely reason. Check duplicate tasks, missing acceptance criteria, empty progress, null results, priority changes, and wrong tool direction. Include event IDs and timestamps. Source: ${JSON.stringify(target).slice(0, 12000)}`, wait: false }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not create review task');
    } catch (error) { setSendError(`Review failed — ${(error as Error).message}`); }
    finally { setReviewing(null); }
  };

  const handleForkTask = async (messageId: string) => {
    if (!sessionId || !project || sending) return;
    setSending(true);
    const fork = await forkSession(sessionId, messageId);
    if (!fork.ok || !fork.sessionId) { setSending(false); setSendError(fork.error ?? 'Could not fork session'); return; }
    const child = await createTask(project.id, 'Forked chat task', `Forked from assistant session ${sessionId} before message ${messageId}.`, 'medium', selectedAgentId || undefined, selectedAgent?.name, fork.sessionId, selectedModel.split('/').slice(1).join('/') || undefined, selectedModel.split('/')[0] || undefined);
    setSending(false);
    if (!child) setSendError('Could not create forked task');
  };

  const selectedAgent = availableAgents.find((a) => a.id === selectedAgentId);
  const exportContent = chatToMarkdown(messages, { title: `Board assistant — ${project.name}`, sessionId, agentName: selectedAgent?.name, preamble: exportPreamble ?? undefined });
  const sessionAgent = (session as any)?.agent
    ? (typeof (session as any).agent === 'string' ? (session as any).agent : (session as any).agent?.name || (session as any).agent?.id)
    : undefined;
  const agentName = selectedAgent?.name || sessionAgent || 'Board assistant';
  const modelHint = selectedModel || undefined;
  const msgCount = messages.length;
  // Welcome copy describes what the link-back actually does (Option B ledger):
  // the board notifier queues a finished task's result into this chat on its
  // own. The user never has to move a session id by hand.
  const who = `${selectedAgent?.name || sessionAgent || 'assistant'} · ${selectedModel || 'server default'}`;
  const welcomeMsg: ChatMessage = {
    id: 'welcome',
    kind: 'assistant',
    markdown: `Board assistant for ${project.name}. Ask about the board or delegate work. Finished tasks report back here.`,
  };

  return (
    <div className={standalone ? 'fixed inset-0 z-50 flex pointer-events-none' : 'fixed z-50 pointer-events-none'} style={standalone ? undefined : { right: CHAT_EDGE_GAP + position.x, bottom: CHAT_EDGE_GAP + position.y }}>
      <div data-assistant-width className="relative w-full flex flex-col pointer-events-auto panel overflow-hidden" style={{ width: standalone ? '100%' : width, height: standalone ? '100%' : height, maxWidth: standalone ? '100%' : '90vw', borderRadius: standalone ? 0 : 10, boxShadow: standalone ? 'none' : '0 12px 40px rgba(0,0,0,0.25)', background: 'var(--surface)', border: '1px solid var(--border)' }}>
        {!standalone && <div onPointerDown={startResize('x')} title="Drag to resize width"
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />}
        {!standalone && <div onPointerDown={startResize('y')} title="Drag to resize height"
          className="absolute left-1.5 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />}
        {!standalone && <div onPointerDown={startResize('xy')} title="Drag to resize"
          className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize hover:bg-violet-500/40 transition-colors z-10"
          style={{ touchAction: 'none' }} />}
        <div onPointerDown={standalone ? undefined : onWindowPointerDown} className={`modal-head px-3.5 py-3 ${standalone ? '' : 'cursor-move'}`} title={standalone ? undefined : 'Drag to move the assistant chat'}>
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
              <button onClick={exportMarkdown} className="btn p-1.5" title="Preview, copy, or download chat">
                <Download className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
              {sessionId && (
                <button onClick={handleNewChat} className="btn p-1.5" title="New assistant chat"><Plus className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
              )}
              {!standalone && <button onClick={popOut} className="btn p-1.5" title="Open assistant in a separate window"><ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} /></button>}
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
            <div className="flex gap-1 relative">
              <button
                type="button"
                onClick={() => { setModelSearch(''); setModelMenuOpen((open) => !open); }}
                className="input mono text-[11px] py-1.5 flex-1 min-w-0 text-left truncate"
                title="Search and select an assistant model — changing starts a new chat"
              >
                {selectedModel || 'Model: default'}
              </button>
              <button type="button" onClick={loadModels} disabled={modelsLoading} className="btn p-1.5 shrink-0" title="Refresh models">
                <RefreshCw className={`w-3 h-3 muted ${modelsLoading ? 'animate-spin' : ''}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute top-full right-0 mt-1 panel p-1.5 z-50 w-[min(420px,90vw)]" style={{ background: 'var(--surface)' }}>
                  <input
                    autoFocus
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                    className="input mono text-[11px] py-1.5 w-full mb-1.5"
                  />
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    <button type="button" onClick={() => { handleModelChange(''); setModelMenuOpen(false); }} className="block w-full text-left px-2.5 py-2 mono text-[11px] rounded hoverable" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}>Model: default</button>
                    {filteredModels.map((m, idx) => {
                      const key = `${m.providerID}/${m.modelID}`;
                      return (
                        <button type="button" key={`${key}__${idx}`} onClick={() => { handleModelChange(key); setModelMenuOpen(false); }} className="block w-full text-left px-2.5 py-2 mono text-[11px] rounded hoverable" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }} title={m.name ? `${key} — ${m.name}` : key}>
                          <span className="block truncate"><span className="font-semibold">{key}</span>{m.name && <span style={{ color: 'var(--muted)' }}> — {m.name}</span>}</span>
                        </button>
                      );
                    })}
                    {filteredModels.length === 0 && <p className="muted mono text-[11px] px-2 py-3 text-center">No models found.</p>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3.5 space-y-3" style={{ background: 'var(--bg)' }}>
          {/* Welcome message — same bubble styling as task chat */}
          <ChatBubble msg={welcomeMsg} agentName={agentName} modelName={modelHint} showAvatar onFileClick={(p) => setPreviewPath(p)} onTaskClick={onTaskClick} onReview={handleReview} />
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
             if (msg.kind === 'tool') return <ToolRow key={msg.id} msg={msg} onFileClick={(p) => setPreviewPath(p)} onAnswered={(id, out) => { answerTool(sessionId!, id, out).then((r) => { if (!r.ok) setSendError(`Could not send the answer — ${r.error ?? 'unknown error'}`); retry(); }); }} onReview={handleReview} />;
             if (msg.kind === 'error') return <ChatErrorRow key={msg.id} msg={msg} detail={msg.id.endsWith('-outcome') ? sessionError : null} onReview={handleReview} />;
            if (msg.kind === 'reasoning') return <ThinkingBlock key={msg.id} msg={msg} showAvatar={startsTurn} agentName={agentName} modelName={modelHint} onFileClick={(p) => setPreviewPath(p)} />;
             if (msg.kind === 'event') return <div key={msg.id} className="text-center text-[11px] font-bold mono py-1" style={{ color: 'var(--muted)' }}>{msg.markdown}</div>;
              return <ChatBubble key={msg.id} msg={msg} agentName={msg.kind === 'user' ? undefined : agentName} modelName={msg.kind === 'user' ? undefined : modelHint} showAvatar={msg.kind === 'user' ? true : startsTurn} onFileClick={(p) => setPreviewPath(p)} onTaskClick={onTaskClick} onReview={handleReview} onEdit={async (m) => { if (!sessionId || !project) return; const fork = await forkSession(sessionId, m.id); if (!fork.ok || !fork.sessionId) { setSendError(fork.error ?? 'Could not edit message'); return; } setSessionId(fork.sessionId); saveAssistantSessionId(project.id, fork.sessionId); const res = await sendPrompt(fork.sessionId, m.markdown, selectedModel); if (!res.ok) setSendError(res.error ?? 'Could not send edited message'); }} onClear={async (m) => { if (!sessionId || !project) return; const fork = await forkSession(sessionId, m.id); if (!fork.ok || !fork.sessionId) { setSendError(fork.error ?? 'Could not clear messages'); return; } setSessionId(fork.sessionId); saveAssistantSessionId(project.id, fork.sessionId); }} onFork={(m) => handleForkTask(m.id)} />;
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
        {speechError && <div className="px-3.5 pt-2 text-[11px]" style={{ color: 'var(--amber)' }}>{speechError}</div>}
        <div className="px-3.5 py-2 border-t hairline flex items-center gap-2" style={{ borderTopWidth: 1, borderTopStyle: 'solid', background: 'var(--surface)' }}>
          <input
            id="assistant-auto-continue"
            type="checkbox"
            checked={autoContinue}
            onChange={toggleAutoContinue}
            className="accent-violet-500 w-3.5 h-3.5"
            aria-label="Automatisch fortsetzen"
            title={`Sendet nach ${autoContinueIdleMin} Minuten ohne Aktivität eine Fortsetzung in dieselbe Session.`}
          />
          <label htmlFor="assistant-auto-continue" className="text-[11px] muted mono cursor-pointer select-none" title={`Sendet nach ${autoContinueIdleMin} Minuten ohne Aktivität eine Fortsetzung in dieselbe Session.`}>
            Automatisch fortsetzen
          </label>
        </div>
        <form onSubmit={busy ? (e) => { e.preventDefault(); handleStop(); } : handleSend} className="p-3 border-t hairline" style={{ borderTopWidth: 1, borderTopStyle: 'solid', background: 'var(--surface)' }}>
          <div className="flex gap-1.5 items-end">
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder={speechTranscribing ? 'Transcribing locally…' : speechListening ? (speechPct != null && speechPct >= 0 ? `Loading voice model ${Math.min(100, Math.round(speechPct * 100))}%…` : 'Listening — speak now…') : busy ? 'Assistant running — Stop to interrupt…' : 'Ask the board assistant…  (↵ send)'} className="input" disabled={busy || creating} autoFocus />
            {speechSupported && (
              <button
                type="button"
                onClick={() => toggleSpeech((text) => setInput((prev) => (prev ? `${prev} ${text}` : text).slice(0, 4000)))}
                disabled={creating || (busy && !speechListening)}
                className="btn p-2 shrink-0"
                title={speechListening ? 'Stop speech input' : 'Use speech input'}
                aria-pressed={speechListening}
                style={speechListening ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
              >
                {speechListening ? <MicOff className="w-4 h-4" strokeWidth={1.75} /> : <Mic className="w-4 h-4" strokeWidth={1.75} />}
              </button>
            )}
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
      {exportOpen && <ChatExportModal title="Export board assistant chat" content={exportContent} fileName={`board-assistant-${(sessionId ?? 'no-session').slice(0, 12)}.md`} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

