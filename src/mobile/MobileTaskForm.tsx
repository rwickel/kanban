import { useState } from 'react';
import { Task, TaskPriority, Agent, OpenCodeModelInfo } from '../types';
import { X, RefreshCw } from 'lucide-react';
import { fetchModels } from '../api/opencode';
import { getTaskModelPref, saveTaskModelPref } from '../store/serverConfig';

// Copied field-by-field from TaskModal. Desktop TaskModal must not change.
export type MobileTaskFormData = {
  title: string;
  description: string;
  priority: TaskPriority;
  agentId?: string;
  agentName?: string;
  modelId?: string;
  modelProviderID?: string;
  result?: string;
  resultContext?: string;
};

export default function MobileTaskForm({
  task,
  availableAgents,
  onClose,
  onSave,
}: {
  task?: Task | null;
  availableAgents: Agent[];
  onClose: () => void;
  onSave: (data: MobileTaskFormData) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium');
  const [selectedAgentId, setSelectedAgentId] = useState(task?.agentId ?? '');
  const [models, setModels] = useState<OpenCodeModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(
    task?.modelId && task?.modelProviderID ? `${task.modelProviderID}/${task.modelId}` : (task?.modelId ?? '')
  );

  const loadModels = async () => {
    if (modelsLoading) return;
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  useState(() => { void loadModels(); });

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
      priority,
      agentId: selectedAgentId || undefined,
      agentName: selectedAgent?.name || undefined,
      modelId: modelID || undefined,
      modelProviderID: providerID || undefined,
      result: (task?.result ?? undefined) as string | undefined,
      resultContext: (task?.resultContext ?? undefined) as string | undefined,
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
          <label className="m-label" htmlFor="mt-title">Title</label>
          <input id="mt-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title..." className="input" autoFocus />
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
            {models.map((m, idx) => {
              const key = `${m.providerID}/${m.modelID}`;
              return (
                <option key={`${key}__${idx}`} value={key}>
                  {key}{m.name && m.name !== m.modelID ? ` — ${m.name}` : ''}
                </option>
              );
            })}
          </select>
        </div>

        <div className="m-overlay-foot">
          <button type="button" className="m-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="m-btn m-btn-primary">{task ? 'Save Changes' : 'Create Task'}</button>
        </div>
      </form>
    </div>
  );
}
