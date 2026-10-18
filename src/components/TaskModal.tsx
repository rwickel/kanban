import { useState, useEffect } from 'react';
import { Task, TaskPriority, TaskStatus, Agent, OpenCodeModelInfo } from '../types';
import { X, RefreshCw } from 'lucide-react';
import { fetchModels } from '../api/opencode';
import { getTaskModelPref, saveTaskModelPref } from '../store/serverConfig';
import { formatModelRef, isModelAllowed, resolveSessionModel } from '../store/modelResolution';
import { normalizeBlockedBy, validateBlockedBy } from '../store/dependencies';
import AttachmentList from './AttachmentList';

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    title: string;
    description: string;
    acceptanceCriteria?: string;
    priority: TaskPriority;
    agentId?: string;
    agentName?: string;
    modelId?: string;
    modelProviderID?: string;
    result?: string;
    resultContext?: string;
    kind?: Task['kind'];
    cycleIntervalSec?: number;
    blockedByTaskIds?: string[];
  }) => void;
  task?: Task | null;
  availableAgents: Agent[];
  /** All tasks of the active project — the source list for the "Depends on" picker. */
  tasks?: Task[];
  /** Models the active project allows ("providerID/modelID").
   *  Empty/absent = no restriction. */
  allowedModels?: string[] | null;
}

export default function TaskModal({ isOpen, onClose, onSave, task, availableAgents, allowedModels, tasks }: TaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [result, setResult] = useState('');
  const [resultContext, setResultContext] = useState('');
  const [kind, setKind] = useState<Task['kind']>('oneshot');
  const [cycleIntervalSec, setCycleIntervalSec] = useState('3600');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [depSearch, setDepSearch] = useState('');
  const [depError, setDepError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDepSearch('');
    setDepError(null);
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setAcceptanceCriteria(task.acceptanceCriteria || '');
      setPriority(task.priority);
      setSelectedAgentId(task.agentId || '');
      setResult(task.result || '');
      setResultContext(task.resultContext || '');
      setKind(task.kind || 'oneshot');
      setCycleIntervalSec(String(task.cycleIntervalSec ?? 3600));
      setBlockedBy(normalizeBlockedBy(task.blockedByTaskIds));
    } else {
      setTitle('');
      setDescription('');
      setAcceptanceCriteria('');
      setPriority('medium');
      setSelectedAgentId('');
      setResult('');
      setResultContext('');
      setKind('oneshot');
      setCycleIntervalSec('3600');
      setBlockedBy([]);
    }
    // Same order as session creation: task pick → browser pref when the project
    // allows it → the project's first allowed model → nothing (server default).
    setSelectedModel(formatModelRef(resolveSessionModel(task, { allowedModels }, getTaskModelPref())));
    loadModels();
  }, [task, isOpen]);

  const loadModels = async () => {
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  const filteredModels = models.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    if (!isModelAllowed(key, allowedModels)) return false;
    const query = modelSearch.trim().toLowerCase();
    return !query || `${key} ${m.name ?? ''}`.toLowerCase().includes(query);
  });
  // A stored pick outside the pool stays visible (and changeable) instead of vanishing.
  const selectedOutsidePool = !!selectedModel && !isModelAllowed(selectedModel, allowedModels);
  const poolSize = (allowedModels ?? []).length;

  // Depends-on picker: every task of this project except the task itself.
  const candidateDeps = (tasks ?? []).filter((t) => t.id !== task?.id);
  const filteredDeps = candidateDeps.filter((t) => {
    const query = depSearch.trim().toLowerCase();
    return !query || `${t.title} ${t.id} ${t.status}`.toLowerCase().includes(query);
  });
  const toggleDep = (id: string) => {
    setDepError(null);
    setBlockedBy((prev) =>
      normalizeBlockedBy(prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]),
    );
  };
  const depStatusCls: Record<TaskStatus, string> = {
    backlog: 'p-neutral', running: 'p-blue', done: 'p-green', blocked: 'p-red',
  };

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    // Same guards as the server: reject self-references and cycles up front.
    let cleanBlockedBy: string[];
    try {
      cleanBlockedBy = validateBlockedBy(task?.id ?? 'new-task', blockedBy, tasks);
      setDepError(null);
    } catch (err) {
      setDepError(err instanceof Error ? err.message : String(err));
      return;
    }
    const selectedAgent = availableAgents.find(a => a.id === selectedAgentId);
    const [providerID, ...rest] = (selectedModel || '').split('/');
    const modelID = rest.join('/');
    if (!task && modelID && providerID) {
      saveTaskModelPref({ providerID, modelID });
    }
    onSave({
      title: title.trim(),
      description: description.trim(),
      acceptanceCriteria: acceptanceCriteria.trim() || undefined,
      priority,
      agentId: selectedAgentId || undefined,
      agentName: selectedAgent?.name || undefined,
      modelId: modelID || undefined,
      modelProviderID: providerID || undefined,
      result: result.trim() || undefined,
      resultContext: resultContext.trim() || undefined,
      kind,
      cycleIntervalSec: kind === 'cyclic' ? Math.max(1, Number(cycleIntervalSec) || 3600) : undefined,
      blockedByTaskIds: cleanBlockedBy,
    });
    onClose();
  };

  const prioCls: Record<TaskPriority, string> = {
    low: 'p-green', medium: 'p-blue', high: 'p-amber', critical: 'p-red',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative modal-card w-full max-w-lg max-h-[calc(100vh-2rem)] mx-4 overflow-hidden flex flex-col animate-fadeIn">
        <div className="flex items-center justify-between px-4 py-3 modal-head">
          <h2 className="text-[13px] font-semibold t-strong">{task ? 'Edit Task' : 'New Task'} <span className="kbd ml-2">N</span></h2>
          <button onClick={onClose} className="btn p-1"><X className="w-4 h-4" strokeWidth={1.75} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Task type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as Task['kind'])} className="input">
              <option value="oneshot">One-shot</option><option value="cyclic">Cyclic</option>
            </select>
            {kind === 'cyclic' && <div className="mt-1.5">
              <label htmlFor="task-cycle-interval" className="block text-[12px] font-medium t-soft mb-1">Repeat every (seconds)</label>
              <input id="task-cycle-interval" type="number" min="1" value={cycleIntervalSec} onChange={(e) => setCycleIntervalSec(e.target.value)} className="input" placeholder="e.g. 3600 = every hour" aria-describedby="task-cycle-help" />
              <p id="task-cycle-help" className="text-[11px] t-muted mt-1">After this delay, the task returns to the backlog and can run again.</p>
            </div>}
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..." className="input" autoFocus />
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description..." rows={3} className="input resize-none" />
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Acceptance criteria <span className="muted font-normal">(optional)</span></label>
            <textarea value={acceptanceCriteria} onChange={(e) => setAcceptanceCriteria(e.target.value)}
              placeholder="What must be true for this task to be accepted?" rows={3} className="input resize-none" />
          </div>
          {task && <div><label className="block text-[12px] font-medium t-soft mb-1">Attachments</label><AttachmentList ownerType="task" ownerId={task.id} /></div>}
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Priority</label>
            <div className="grid grid-cols-4 gap-1.5">
              {(['low', 'medium', 'high', 'critical'] as TaskPriority[]).map((p) => (
                <button key={p} type="button" onClick={() => setPriority(p)}
                  className={`pill justify-center py-1.5 uppercase ${priority === p ? prioCls[p] : 'p-neutral'}`}>
                  {p === 'critical' ? 'URGENT' : p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Depends on <span className="muted font-normal">(predecessors that must be done first)</span></label>
            {candidateDeps.length === 0 ? (
              <p className="text-[11px] muted">No other tasks in this project yet — nothing to depend on.</p>
            ) : (
              <>
                {blockedBy.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {blockedBy.map((id) => {
                      const dep = candidateDeps.find((t) => t.id === id);
                      return (
                        <span key={id} className={`pill ${dep ? depStatusCls[dep.status] : 'p-neutral'} flex items-center gap-1 max-w-full`} title={id}>
                          <span className="truncate">{dep ? dep.title : id}</span>
                          <button type="button" onClick={() => toggleDep(id)} title="Remove dependency" className="shrink-0">
                            <X className="w-3 h-3" strokeWidth={2} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <input type="text" value={depSearch} onChange={(e) => setDepSearch(e.target.value)}
                  placeholder="Search tasks in this project..." className="input mb-1" />
                <ul className="max-h-40 overflow-y-auto rounded border border-[var(--border)] divide-y divide-[var(--border)]">
                  {filteredDeps.map((t) => (
                    <li key={t.id}>
                      <label className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hoverable">
                        <input type="checkbox" checked={blockedBy.includes(t.id)} onChange={() => toggleDep(t.id)} className="shrink-0" />
                        <span className="flex-1 text-[12px] truncate">{t.title}</span>
                        <span className={`pill ${depStatusCls[t.status]} px-1.5 py-0 text-[10px] uppercase shrink-0`}>{t.status}</span>
                        <span className="text-[10px] muted mono shrink-0">{t.id.slice(0, 8)}</span>
                      </label>
                    </li>
                  ))}
                  {filteredDeps.length === 0 && (
                    <li className="px-2 py-2 text-[11px] muted">No task matches "{depSearch}".</li>
                  )}
                </ul>
              </>
            )}
            {blockedBy.length > 0 && (
              <p className="text-[11px] muted mt-1">
                {blockedBy.length} predecessor{blockedBy.length === 1 ? '' : 's'} — this task stays in the backlog until all of them are done.
              </p>
            )}
            {depError && <p className="text-[11px] text-red-400/90 mt-1">{depError}</p>}
          </div>
          {availableAgents.length > 0 ? (
            <div>
              <label className="block text-[12px] font-medium t-soft mb-1">Assign Agent</label>
              <select value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)} className="input">
                <option value="">No agent assigned</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-[11px] muted">No agents available — check the server connection.</p>
          )}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[12px] font-medium t-soft">Model</label>
              <button type="button" onClick={loadModels} disabled={modelsLoading}
                className="p-1 rounded hoverable" title="Refresh models">
                <RefreshCw className={`w-3 h-3 muted ${modelsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="relative">
            <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="input mono">
              <option value="">Server default</option>
              {filteredModels.map((m, idx) => {
                const key = `${m.providerID}/${m.modelID}`;
                return (
                  <option key={`${key}__${idx}`} value={key}>
                    {key}{m.name && m.name !== m.modelID ? ` — ${m.name}` : ''}
                  </option>
                );
              })}
              {selectedOutsidePool && (
                <option value={selectedModel}>{selectedModel} (not allowed in this project)</option>
              )}
            </select>
            <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)}
              placeholder="Search models..." className="input mono mt-1.5" />
            </div>
            <p className="text-[11px] muted mt-1">
              Passed as <span className="mono">model: {"{ providerID, modelID }"}</span> when the session is created — so the build worker stops falling back to the global default.
            </p>
            {poolSize > 0 && (
              <p className="text-[11px] text-amber-400/90 mt-1">
                {poolSize} model{poolSize === 1 ? '' : 's'} allowed in this project — pick from that list or change it in Project settings.
              </p>
            )}
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Result <span className="muted font-normal">(last message + context, on done/blocked)</span></label>
            <textarea value={result} onChange={(e) => setResult(e.target.value)}
              placeholder="Result — filled by the agent on done/blocked…" rows={2} className="input resize-none mono" />
          </div>
          <div>
            <label className="block text-[12px] font-medium t-soft mb-1">Result context</label>
            <input type="text" value={resultContext} onChange={(e) => setResultContext(e.target.value)}
              placeholder="Optional extra context…" className="input mono" />
          </div>
          <div className="sticky bottom-0 flex items-center justify-end gap-2 pt-3 pb-1 -mx-4 px-4 modal-card">
            <button type="button" onClick={onClose} className="btn px-3 py-1.5 text-[12px] font-medium">Cancel <span className="kbd ml-1">esc</span></button>
            <button type="submit" className="btn btn-primary px-3 py-1.5 text-[12px] font-medium">{task ? 'Save Changes' : 'Create Task'} <span className="kbd ml-1" style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>↵</span></button>
          </div>
        </form>
      </div>
    </div>
  );
}
