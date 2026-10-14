import { useState, useEffect } from 'react';
import { Task, TaskPriority, Agent, OpenCodeModelInfo } from '../types';
import { X, RefreshCw } from 'lucide-react';
import { fetchModels } from '../api/opencode';
import { getTaskModelPref, saveTaskModelPref } from '../store/serverConfig';

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
  }) => void;
  task?: Task | null;
  availableAgents: Agent[];
}

export default function TaskModal({ isOpen, onClose, onSave, task, availableAgents }: TaskModalProps) {
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

  useEffect(() => {
    if (!isOpen) return;
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setAcceptanceCriteria(task.acceptanceCriteria || '');
      setPriority(task.priority);
      setSelectedAgentId(task.agentId || '');
      setResult(task.result || '');
      setResultContext(task.resultContext || '');
      setSelectedModel(
        task.modelId && task.modelProviderID
          ? `${task.modelProviderID}/${task.modelId}`
          : task.modelId || ''
      );
    } else {
      setTitle('');
      setDescription('');
      setAcceptanceCriteria('');
      setPriority('medium');
      setSelectedAgentId('');
      setResult('');
      setResultContext('');
      const pref = getTaskModelPref();
      setSelectedModel(pref ? `${pref.providerID}/${pref.modelID}` : '');
    }
    loadModels();
  }, [task, isOpen]);

  const loadModels = async () => {
    setModelsLoading(true);
    const list = await fetchModels();
    setModels(list);
    setModelsLoading(false);
  };

  const filteredModels = models.filter((m) => {
    const query = modelSearch.trim().toLowerCase();
    return !query || `${m.providerID}/${m.modelID} ${m.name ?? ''}`.toLowerCase().includes(query);
  });

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
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
    });
    onClose();
  };

  const prioCls: Record<TaskPriority, string> = {
    low: 'p-green', medium: 'p-blue', high: 'p-amber', critical: 'p-red',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative modal-card w-full max-w-lg mx-4 overflow-hidden animate-fadeIn">
        <div className="flex items-center justify-between px-4 py-3 modal-head">
          <h2 className="text-[13px] font-semibold t-strong">{task ? 'Edit Task' : 'New Task'} <span className="kbd ml-2">N</span></h2>
          <button onClick={onClose} className="btn p-1"><X className="w-4 h-4" strokeWidth={1.75} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
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
            </select>
            <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)}
              placeholder="Search models..." className="input mono mt-1.5" />
            </div>
            <p className="text-[11px] muted mt-1">
              Passed as <span className="mono">model: {"{ providerID, modelID }"}</span> when the session is created — so the build worker stops falling back to the global default.
            </p>
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
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn px-3 py-1.5 text-[12px] font-medium">Cancel <span className="kbd ml-1">esc</span></button>
            <button type="submit" className="btn btn-primary px-3 py-1.5 text-[12px] font-medium">{task ? 'Save Changes' : 'Create Task'} <span className="kbd ml-1" style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}>↵</span></button>
          </div>
        </form>
      </div>
    </div>
  );
}
