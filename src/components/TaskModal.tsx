import { useState, useEffect } from 'react';
import { Task, TaskPriority, Agent } from '../types';
import { X } from 'lucide-react';

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    title: string;
    description: string;
    priority: TaskPriority;
    agentId?: string;
    agentName?: string;
  }) => void;
  task?: Task | null;
  availableAgents: Agent[];
}

export default function TaskModal({ isOpen, onClose, onSave, task, availableAgents }: TaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setPriority(task.priority);
      setSelectedAgentId(task.agentId || '');
    } else {
      setTitle('');
      setDescription('');
      setPriority('medium');
      setSelectedAgentId('');
    }
  }, [task, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const selectedAgent = availableAgents.find(a => a.id === selectedAgentId);
    onSave({
      title: title.trim(),
      description: description.trim(),
      priority,
      agentId: selectedAgentId || undefined,
      agentName: selectedAgent?.name || undefined,
    });
    onClose();
  };

  const priorityOptions: { value: TaskPriority; label: string; color: string }[] = [
    { value: 'low', label: 'Low', color: 'hover:border-slate-300 data-[active=true]:border-slate-400 data-[active=true]:bg-slate-50' },
    { value: 'medium', label: 'Med', color: 'hover:border-blue-300 data-[active=true]:border-blue-500 data-[active=true]:bg-blue-50 data-[active=true]:text-blue-700' },
    { value: 'high', label: 'High', color: 'hover:border-amber-300 data-[active=true]:border-amber-500 data-[active=true]:bg-amber-50 data-[active=true]:text-amber-700' },
    { value: 'critical', label: 'Urgent', color: 'hover:border-red-300 data-[active=true]:border-red-500 data-[active=true]:bg-red-50 data-[active=true]:text-red-700' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-white border border-slate-200 rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.08)] w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h2 className="text-[13px] font-semibold text-slate-900">
            {task ? 'Edit task' : 'New task'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-[3px] hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {/* Title */}
          <div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-[4px] text-[13px] text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-400/20 transition-all"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={3}
              className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-[4px] text-[13px] text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-400/20 transition-all resize-none"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Priority</label>
            <div className="grid grid-cols-4 gap-1.5">
              {priorityOptions.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  data-active={priority === p.value}
                  onClick={() => setPriority(p.value)}
                  className={`px-2 py-1.5 rounded-[4px] border text-[11px] font-medium text-slate-600 border-slate-200 bg-white transition-all ${p.color}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Agent Selection */}
          {availableAgents.length > 0 && (
            <div>
              <label className="block text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Agent</label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-[4px] text-[13px] text-slate-900 focus:outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-400/20 transition-all"
              >
                <option value="">Unassigned</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-[4px] border border-slate-200 text-slate-600 hover:bg-slate-50 text-[12px] font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 rounded-[4px] bg-slate-900 text-white text-[12px] font-medium hover:bg-slate-800 transition-colors"
            >
              {task ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
