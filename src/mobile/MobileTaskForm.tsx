import { useState } from 'react';
import { Task, TaskPriority, Agent, OpenCodeModelInfo } from '../types';
import { X, RefreshCw } from 'lucide-react';
import { fetchModels } from '../api/opencode';
import { getTaskModelPref, saveTaskModelPref } from '../store/serverConfig';
import { formatModelRef, isModelAllowed, resolveSessionModel } from '../store/modelResolution';

// Mobile task form uses the same task fields as the desktop form.
export type MobileTaskFormData = {
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
  dueDate?: string;
};

export default function MobileTaskForm({
  task,
  availableAgents,
  onClose,
  onSave,
  allowedModels,
}: {
  task?: Task | null;
  availableAgents: Agent[];
  onClose: () => void;
  onSave: (data: MobileTaskFormData) => void;
  /** Models the active project allows ("providerID/modelID"). Empty/absent = no restriction. */
  allowedModels?: string[] | null;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(task?.acceptanceCriteria ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [selectedAgentId, setSelectedAgentId] = useState(task?.agentId ?? '');
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  // Same order as session creation: task pick → browser pref when allowed →
  // the project's first allowed model → nothing (server default).
  const [selectedModel, setSelectedModel] = useState(() =>
    formatModelRef(resolveSessionModel(task, { allowedModels }, getTaskModelPref()))
  );
  const [kind, setKind] = useState<Task['kind']>(task?.kind ?? 'oneshot');
  const [cycleIntervalSec, setCycleIntervalSec] = useState(String(task?.cycleIntervalSec ?? 3600));

  const loadModels = async () => {
    if (modelsLoading) return;
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  useState(() => { void loadModels(); });

  const query = modelSearch.trim().toLowerCase();
  const visibleModels = models.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    if (!isModelAllowed(key, allowedModels)) return false;
    return !query || `${key} ${m.name ?? ''}`.toLowerCase().includes(query);
  });
  // A stored pick outside the pool stays visible (and changeable) instead of vanishing.
  const selectedOutsidePool = !!selectedModel && !isModelAllowed(selectedModel, allowedModels);
  const poolSize = (allowedModels ?? []).length;

  const prioCls: Record<TaskPriority, string> = {
    low: 'p-green', medium: 'p-blue', high: 'p-amber', critical: 'p-red',
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const selectedAgent = availableAgents.find(a => a.id === selectedAgentId);
    const [providerID, ...rest] = (selectedModel || '').split('/');
    const modelID = rest.join('/');
    if (!task && modelID && providerID) {
      saveTaskModelPref({ providerID, modelID });
    } else {
      const pref0 = getTaskModelPref();
      if (!pref0 && modelID && providerID) saveTaskModelPref({ providerID, modelID });
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
      result: (task?.result ?? undefined) as string | undefined,
      resultContext: (task?.resultContext ?? undefined) as string | undefined,
      kind,
      cycleIntervalSec: kind === 'cyclic' ? Math.max(1, Number(cycleIntervalSec) || 3600) : undefined,
      dueDate: dueDate || undefined,
    });
    onClose();
  };

  return (
    <div className="m-full" role="dialog" aria-label={task ? 'Edit task' : 'New task'}>
      <header className="m-overlay-head">
        <span className="m-overlay-title">{task ? 'Edit Task' : 'New Task'}</span>
        <button className="m-icon-btn" onClick={onClose} aria-label="Close task form">
          <X className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </header>

      <form onSubmit={handleSubmit} className="m-overlay-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="m-field">
          <label className="m-label" htmlFor="mt-kind">Task type</label>
          <select id="mt-kind" value={kind} onChange={(e) => setKind(e.target.value as Task['kind'])} className="input">
            <option value="oneshot">One-shot</option><option value="cyclic">Cyclic</option>
          </select>
          {kind === 'cyclic' && <div style={{ marginTop: 6 }}>
            <label className="m-label" htmlFor="mt-cycle-interval">Repeat every (seconds)</label>
            <input id="mt-cycle-interval" type="number" min="1" value={cycleIntervalSec} onChange={(e) => setCycleIntervalSec(e.target.value)} className="input" placeholder="e.g. 3600 = every hour" aria-describedby="mt-cycle-help" />
            <p id="mt-cycle-help" className="muted" style={{ marginTop: 4 }}>After this delay, the task returns to the backlog and can run again.</p>
          </div>}
        </div>
        <div className="m-field">
          <label className="m-label" htmlFor="mt-title">Title</label>
          <input id="mt-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title..." className="input" autoFocus />
        </div>

        <div className="m-field">
          <label className="m-label" htmlFor="mt-acceptance">Acceptance criteria <span className="muted">(optional)</span></label>
          <textarea id="mt-acceptance" value={acceptanceCriteria} onChange={(e) => setAcceptanceCriteria(e.target.value)}
            placeholder="What must be true for this task to be accepted?" rows={4} className="input resize-none" />
        </div>

        <div className="m-field">
          <label className="m-label" htmlFor="mt-desc">Description</label>
          <textarea id="mt-desc" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Task description..." rows={5} className="input resize-none" />
        </div>

        <div className="m-field">
          <label className="m-label">Priority</label>
          <div className="m-seg">
            {(['low', 'medium', 'high', 'critical'] as TaskPriority[]).map((p) => (
              <button key={p} type="button" onClick={() => setPriority(p)}
                className={`m-btn ${priority === p ? prioCls[p] : ''} ${priority === p ? 'is-active' : ''}`}>
                {p === 'critical' ? 'URGENT' : p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="m-field">
          <label className="m-label" htmlFor="mt-due-date">Due date (optional)</label>
          <input id="mt-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="input" />
          {dueDate && <button type="button" className="muted" onClick={() => setDueDate('')}>Clear due date</button>}
        </div>

        <div className="m-field">
          <label className="m-label" htmlFor="mt-agent">Assign Agent</label>
          <select id="mt-agent" value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)} className="input">
            <option value="">No agent assigned</option>
            {availableAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div className="m-field">
          <div className="flex items-center justify-between mb-1" style={{ display: 'flex' }}>
            <label className="m-label" htmlFor="mt-model">Model</label>
            <button type="button" onClick={loadModels} disabled={modelsLoading}
              style={{ minWidth: 44, minHeight: 44, border: 0, background: 'none' }} title="Refresh models">
              <RefreshCw className={`w-4 h-4 muted ${modelsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <select id="mt-model" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} className="input mono">
            <option value="">Server default</option>
            {visibleModels.map((m, idx) => {
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
            placeholder="Search models…" className="input mono" style={{ marginTop: 6 }} />
          {poolSize > 0 && (
            <p className="m-hint" style={{ color: 'var(--amber)' }}>
              {poolSize} model{poolSize === 1 ? '' : 's'} allowed in this project — pick from that list or change it in Project settings.
            </p>
          )}
        </div>

        <div className="m-overlay-foot">
          <button type="button" className="m-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="m-btn m-btn-primary">{task ? 'Save Changes' : 'Create Task'}</button>
        </div>
      </form>
    </div>
  );
}
