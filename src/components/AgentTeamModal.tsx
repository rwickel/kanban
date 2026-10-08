import { useState, useEffect } from 'react';
import { OpenCodeAgentInfo } from '../types';
import { X, Check, RefreshCw, Users } from 'lucide-react';
import { fetchAgents } from '../api/opencode';

interface AgentTeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (agentIds: string[]) => void;
  selectedAgentIds: string[];
}

export default function AgentTeamModal({ isOpen, onClose, onSave, selectedAgentIds }: AgentTeamModalProps) {
  const [agents, setAgents] = useState<OpenCodeAgentInfo[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>(selectedAgentIds);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setCheckedIds(selectedAgentIds);
      loadAgents();
    }
  }, [isOpen, selectedAgentIds]);

  const loadAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedAgents = await fetchAgents();
      if (fetchedAgents.length > 0) {
        setAgents(fetchedAgents);
      } else {
        setAgents([
          { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#6366f1' },
          { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
          { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
          { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
          { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
        ]);
        setError('Could not connect to OpenCode API. Using demo agents.');
      }
    } catch {
      setAgents([
        { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#6366f1' },
        { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
        { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
        { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
        { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
      ]);
      setError('Could not connect to OpenCode API. Using demo agents.');
    }
    setLoading(false);
  };

  const toggleAgent = (id: string) => {
    setCheckedIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    onSave(checkedIds);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-white border border-slate-200 rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.08)] w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-600" />
            <h2 className="text-[13px] font-semibold text-slate-900">Agent team</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-[3px] hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {error && (
            <div className="mb-3 p-2.5 rounded-[4px] bg-amber-50 border border-amber-200 text-amber-700 text-[11px]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] text-slate-500">Select agents for this project</p>
            <button
              onClick={loadAgents}
              disabled={loading}
              className="p-1 rounded-[3px] hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-50"
              title="Refresh agents"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="space-y-1 max-h-[280px] overflow-y-auto">
            {loading && agents.length === 0 ? (
              <div className="flex items-center justify-center h-24">
                <RefreshCw className="w-4 h-4 text-slate-400 animate-spin" />
              </div>
            ) : (
              agents.map((agent) => {
                const isChecked = checkedIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className={`w-full flex items-center gap-2.5 p-2 rounded-[4px] border transition-all ${
                      isChecked
                        ? 'border-slate-300 bg-slate-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div
                      className="w-5 h-5 rounded-[3px] flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: (agent.color || '#6366f1') + '20' }}
                    >
                      <span
                        className="text-[9px] font-bold"
                        style={{ color: agent.color || '#6366f1' }}
                      >
                        {agent.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 text-left">
                      <p className="text-[12px] font-medium text-slate-900">{agent.name}</p>
                      {agent.description && (
                        <p className="text-[10px] text-slate-500">{agent.description}</p>
                      )}
                    </div>
                    <div
                      className={`w-4 h-4 rounded-[3px] border flex items-center justify-center transition-all ${
                        isChecked
                          ? 'border-slate-900 bg-slate-900'
                          : 'border-slate-300 bg-white'
                      }`}
                    >
                      {isChecked && <Check className="w-2.5 h-2.5 text-white" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200">
          <span className="text-[11px] text-slate-500">
            {checkedIds.length} agent{checkedIds.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-[4px] border border-slate-200 text-slate-600 hover:bg-slate-50 text-[12px] font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded-[4px] bg-slate-900 text-white text-[12px] font-medium hover:bg-slate-800 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
