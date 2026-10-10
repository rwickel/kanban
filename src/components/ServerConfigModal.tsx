import { useState, useEffect } from 'react';
import { X, Server, Lock, Link2, CheckCircle2, XCircle, Loader2, Eye, EyeOff } from 'lucide-react';
import { getServerConfig, saveServerConfig } from '../store/serverConfig';
import { testConnection } from '../api/opencode';
interface ServerConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected: () => void;
}

export default function ServerConfigModal({ isOpen, onClose, onConnected }: ServerConfigModalProps) {
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; agentCount: number; status?: number } | null>(null);

  useEffect(() => {
    if (isOpen) {
      const cfg = getServerConfig();
      setUrl(cfg.url);
      setPassword('');
      setResult(null);
      // Show whether the server already has a password (never its value).
      fetch('/api/kanban/server').then(async (r) => {
        try {
          const j = await r.json();
          if (j?.url) setUrl(j.url);
        } catch { /* offline */ }
      }).catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    const r = await testConnection(url.trim(), password);
    setResult(r);
    setTesting(false);
  };

  const handleSave = async () => {
    // Test first (server-side), then persist server-side + connect.
    setTesting(true);
    setResult(null);
    const r = await testConnection(url.trim(), password);
    setResult(r);
    setTesting(false);
    if (r.ok) {
      saveServerConfig({ url: url.trim() });
      // Persist server-side only — the browser never keeps the password.
      try {
        await fetch('/api/kanban/server', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url.trim(), password }),
        });
      } catch { /* offline — delegate falls back to env */ }
      setPassword('');
      onConnected();
      onClose();
    }
  };

  const handleSaveOnly = () => {
    saveServerConfig({ url: url.trim() });
    try {
      fetch('/api/kanban/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), password }),
      }).catch(() => {});
    } catch { /* offline */ }
    setPassword('');
    onConnected();
    onClose();
  };

  const handleDisconnect = () => {
    try {
      fetch('/api/kanban/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' }),
      }).catch(() => {});
    } catch { /* offline */ }
    onConnected();
    onClose();
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
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:4096"
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all font-mono text-sm"
            />
            <p className="text-[11px] text-gray-500 mt-1">OpenCode v2 API base (e.g. http://localhost:4096)</p>
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-gray-500" /> Server Password
              </span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="OPENCODE_SERVER_PASSWORD"
                className="w-full px-3 py-2.5 pr-10 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Sent once to the board server, kept in .kanban-data/opencode.json. Never stored in the browser.</p>
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
          <button
            onClick={handleDisconnect}
            className="px-3 py-2.5 rounded-xl text-xs text-gray-500 hover:text-red-400 transition-colors"
            title="Clear saved password and go to Demo Mode"
          >
            Disconnect
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testing || !url.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {testing && <Loader2 className="w-4 h-4 animate-spin" />}
              Test
            </button>
            <button
              onClick={handleSave}
              disabled={testing || !url.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20 disabled:opacity-50"
            >
              {testing && <Loader2 className="w-4 h-4 animate-spin" />}
              Save & Connect
            </button>
            <button
              onClick={handleSaveOnly}
              disabled={testing || !url.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors disabled:opacity-50"
              title="Save without testing the connection"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
