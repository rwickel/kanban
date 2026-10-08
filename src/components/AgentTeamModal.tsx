import { useState, useEffect } from 'react';
import { Agent, OpenCodeAgentInfo } from '../types';
import { X, Check, RefreshCw, Bot } from 'lucide-react';
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
        // Fallback demo agents if API is not available
        setAgents([
          { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#8b5cf6' },
          { id: 'reviewer', name: 'Reviewer', description: 'Code review agent', color: '#3b82f6' },
          { id: 'tester', name: 'Tester', description: 'Testing agent', color: '#10b981' },
          { id: 'architect', name: 'Architect', description: 'Architecture agent', color: '#f59e0b' },
          { id: 'debugger', name: 'Debugger', description: 'Debugging agent', color: '#ef4444' },
        ]);
        setError('Could not connect to OpenCode API. Using demo agents.');
      }
    } catch {
      setAgents([
        { id: 'coder', name: 'Coder', description: 'General coding agent', color: '#8b5cf6' },
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-gray-100">Agent Team</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-gray-400">Select agents for this project</p>
            <button
              onClick={loadAgents}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              title="Refresh agents"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {loading && agents.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <RefreshCw className="w-5 h-5 text-gray-500 animate-spin" />
              </div>
            ) : (
              agents.map((agent) => {
                const isChecked = checkedIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all ${
                      isChecked
                        ? 'border-violet-500/50 bg-violet-500/10'
                        : 'border-gray-700/50 bg-gray-800/50 hover:border-gray-600'
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: (agent.color || '#8b5cf6') + '30' }}
                    >
                      <span
                        className="text-xs font-bold"
                        style={{ color: agent.color || '#8b5cf6' }}
                      >
                        {agent.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 text-left">
                      <p className="text-sm font-medium text-gray-100">{agent.name}</p>
                      {agent.description && (
                        <p className="text-xs text-gray-400">{agent.description}</p>
                      )}
                    </div>
                    <div
                      className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                        isChecked
                          ? 'border-violet-500 bg-violet-500'
                          : 'border-gray-600 bg-gray-800'
                      }`}
                    >
                      {isChecked && <Check className="w-3 h-3 text-white" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-gray-700/50">
          <span className="text-xs text-gray-500">
            {checkedIds.length} agent{checkedIds.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20"
            >
              Save Team
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
