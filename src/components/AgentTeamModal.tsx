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
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative modal-card w-full max-w-lg mx-4 overflow-hidden animate-fadeIn">
        {/* Header — matches TaskModal / theme vars */}
        <div className="flex items-center justify-between px-4 py-3 modal-head">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 muted" strokeWidth={1.75} />
            <h2 className="text-[13px] font-semibold t-strong">Agent Team</h2>
            <span className="pill p-neutral mono text-[11px]">{agents.length} agents</span>
          </div>
          <button onClick={onClose} className="btn p-1" aria-label="Close">
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {error && (
            <div className="mb-3 px-3 py-2 rounded-md text-[12px] p-amber">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between mb-2.5">
            <p className="text-[12px] muted">Select agents for this project</p>
            <button
              onClick={loadAgents}
              disabled={loading}
              className="btn p-1 disabled:opacity-50"
              title="Refresh agents"
              aria-label="Refresh agents"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            </button>
          </div>

          <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-1">
            {loading && agents.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <RefreshCw className="w-4 h-4 muted animate-spin" />
              </div>
            ) : (
              agents.map((agent) => {
                const isChecked = checkedIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors ${
                      isChecked
                        ? 'bg-[var(--surface-2)]'
                        : 'bg-[var(--surface)] hoverable'
                    }`}
                    style={{ borderColor: isChecked ? 'var(--border-strong)' : 'var(--border)' }}
                  >
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mono text-[11px] font-bold"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${agent.color || '#0F172A'} 14%, var(--surface-2))`,
                        color: agent.color || 'var(--text)',
                        border: `1px solid color-mix(in srgb, ${agent.color || '#0F172A'} 22%, transparent)`,
                      }}
                    >
                      {agent.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium t-strong leading-tight truncate">{agent.name}</p>
                      {agent.description && (
                        <p className="text-[11px] muted leading-tight truncate">{agent.description}</p>
                      )}
                    </div>
                    <div
                      className="w-[18px] h-[18px] rounded flex items-center justify-center flex-shrink-0 transition-colors"
                      style={{
                        border: `1.5px solid ${isChecked ? 'var(--accent)' : 'var(--border-strong)'}`,
                        background: isChecked ? 'var(--accent)' : 'var(--surface)',
                        color: 'var(--accent-text)',
                      }}
                    >
                      {isChecked && <Check className="w-3 h-3" strokeWidth={2.5} />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t hairline" style={{ borderTopStyle: 'solid', borderTopWidth: 1 }}>
          <span className="text-[11px] mono muted">
            {checkedIds.length} agent{checkedIds.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="btn px-3 py-1.5 text-[12px] font-medium"
            >
              Cancel <span className="kbd ml-1">esc</span>
            </button>
            <button
              onClick={handleSave}
              className="btn btn-primary px-3 py-1.5 text-[12px] font-medium"
            >
              Save Team
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
