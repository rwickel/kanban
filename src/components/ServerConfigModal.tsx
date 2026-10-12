import { useState, useEffect } from 'react';
import { X, Server, Link2, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { testConnection } from '../api/opencode';
interface ServerConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected: () => void | Promise<void>;
}

export default function ServerConfigModal({ isOpen, onClose, onConnected }: ServerConfigModalProps) {
  const [url, setUrl] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; agentCount: number; status?: number } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setResult(null);
      fetch('/api/kanban/server').then(async (r) => {
        try {
          const j = await r.json();
          if (j?.url) setUrl(j.url);
          setHasPassword(Boolean(j?.hasPassword));
        } catch { /* offline */ }
      }).catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    const r = await testConnection();
    setResult(r);
    setTesting(false);
    await onConnected();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <div className="flex items-center gap-2">
            <Server className="w-5 h-5 text-violet-400" />
            <h2 className="text-lg font-semibold text-gray-100">Server Connection</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Server URL */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-gray-500" /> Server URL
              </span>
            </label>
            <input
              type="text"
              value={url}
              readOnly
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-400 font-mono text-sm"
            />
            <p className="text-[11px] text-gray-500 mt-1">Managed by OPENCODE_SERVER_URL in the root .env file.</p>
          </div>

          <div className="rounded-xl border border-gray-700 bg-gray-800 px-3 py-2.5 text-xs text-gray-400">
            OPENCODE_SERVER_PASSWORD: {hasPassword ? 'configured in .env' : 'missing from .env'}
          </div>

          {/* Test result */}
          {result && (
            <div className={`flex items-center gap-2 p-3 rounded-xl text-xs border ${
              result.ok
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              {result.ok
                ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                : <XCircle className="w-4 h-4 flex-shrink-0" />}
              <span>
                {result.ok
                  ? `Connected — ${result.agentCount} agent${result.agentCount !== 1 ? 's' : ''} found.`
                  : result.status === 401
                    ? 'Unauthorized (401) — check the password.'
                    : result.status
                      ? `Server returned ${result.status}. Check the URL.`
                      : 'Could not reach the server. Check the URL.'}
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-gray-700/50">
          <button onClick={onClose} className="px-3 py-2.5 rounded-xl text-xs text-gray-400 hover:text-white transition-colors">Close</button>
          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testing || !url || !hasPassword}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {testing && <Loader2 className="w-4 h-4 animate-spin" />}
              Test
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
