import { useState, useEffect } from 'react';
import { Project, FolderGitInfo } from '../types';
import { X, RefreshCw, FolderOpen, GitBranch } from 'lucide-react';
import { getRoots, getFolderGit } from '../store/kanban';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    folder: string;
    description: string;
    gitUrl?: string;
    gitBranch?: string;
    mkdir?: boolean;
  }) => void;
  project?: Project | null;
}

const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export default function ProjectModal({ isOpen, onClose, onSave, project }: ProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [root, setRoot] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [newMode, setNewMode] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [gitBranch, setGitBranch] = useState('main');
  const [gitInfo, setGitInfo] = useState<FolderGitInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoots = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getRoots();
      setRoot(r.root);
      setFolders(r.folders);
      if (!r.root) setError('KANBAN_PROJECTS_ROOT not set on server — add it to .env');
    } catch {
      setError('Cannot reach kanban store — is vite running?');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setName(project?.name ?? '');
    setDescription(project?.description ?? '');
    setFolder(project?.folder ?? '');
    setGitUrl(project?.gitUrl ?? '');
    setGitBranch(project?.gitBranch ?? 'main');
    setNewMode(false);
    setNewFolder('');
    setCloneUrl('');
    setGitInfo(null);
    setBranches([]);
    loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, isOpen]);

  // Load git info when folder selection changes.
  useEffect(() => {
    if (!isOpen || !folder || newMode) {
      setGitInfo(null);
      setBranches([]);
      return;
    }
    let live = true;
    getFolderGit(folder).then((info) => {
      if (!live || !info) return;
      setGitInfo(info);
      if (info.isRepo) {
        const list = info.branches?.length ? info.branches : (info.branch ? [info.branch] : []);
        setBranches(list);
        // Default pinned branch to current checkout branch.
        if (info.branch) setGitBranch((b) => (b === 'main' || !b ? info.branch! : b));
        if (info.remote && !gitUrl) setGitUrl(info.remote);
      } else {
        setBranches([]);
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, newMode, isOpen]);

  if (!isOpen) return null;

  const effectiveFolder = newMode ? newFolder.trim() : folder;
  const folderValid = FOLDER_RE.test(effectiveFolder);
  // Only folders inside the base path are allowed: existing list or a new
  // name that will be created under root. No absolute paths, no "..".
  const isNewOutsideList = newMode && !folders.includes(effectiveFolder);
  const resolvedPath = effectiveFolder && root
    ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${effectiveFolder}`
    : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !effectiveFolder) return;
    if (!folderValid) return;
    onSave({
      name: name.trim(),
      folder: effectiveFolder,
      description: description.trim(),
      gitUrl: (newMode ? cloneUrl.trim() : gitUrl.trim()) || undefined,
      gitBranch: gitBranch.trim() || 'main',
      mkdir: newMode,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative modal-card w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 modal-head">
          <h2 className="text-lg font-semibold text-gray-100">
            {project ? 'Edit Project' : 'New Project'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Project Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project" autoFocus
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all" />
          </div>

          {/* Folder — only inside base path. Browsers cannot open an OS dialog
              at the server base path, so the server lists it instead. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-300">
                Folder <span className="text-gray-500 font-normal">in {root || 'base path…'}</span>
              </label>
              <button type="button" onClick={loadRoots} disabled={loading}
                className="p-1 rounded hoverable" title="Refresh folder list">
                <RefreshCw className={`w-3.5 h-3.5 muted ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {error && <p className="text-[12px] text-red-400 mb-2">{error}</p>}
            {!newMode ? (
              <div className="flex gap-2">
                <select value={folder} onChange={(e) => setFolder(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                  <option value="">Select folder…</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <button type="button" onClick={() => { setNewMode(true); setNewFolder(''); }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm font-medium hover:bg-gray-700 transition-colors"
                  title="Create a new folder under the base path">
                  <FolderOpen className="w-4 h-4" /> New
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input type="text" value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
                  placeholder="my-new-project"
                  className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50" />
                <button type="button" onClick={() => { setNewMode(false); setNewFolder(''); }}
                  className="shrink-0 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm hover:bg-gray-700">
                  Existing
                </button>
              </div>
            )}
            {effectiveFolder && !folderValid && (
              <p className="text-[11px] text-amber-400 mt-1.5">
                Only letters/digits plus <span className="mono">._-</span>, max 64 chars, no slashes or spaces.
              </p>
            )}
            {resolvedPath && folderValid && (
              <p className="text-[11px] text-gray-500 mt-1.5 font-mono break-all">
                → {resolvedPath}
                {isNewOutsideList && <span className="text-violet-400"> (will be created)</span>}
              </p>
            )}
            {newMode && (
              <label className="block text-[12px] text-gray-400 mt-2">
                Clone URL <span className="text-gray-500">(optional — clones into the new folder)</span>
                <input type="text" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              </label>
            )}
          </div>

          {/* Git — link repo + pinned branch */}
          <div className="rounded-xl border border-gray-700 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-gray-300">
              <GitBranch className="w-3.5 h-3.5" /> Git
              {gitInfo?.isRepo && gitInfo.branch && (
                <span className="pill p-neutral mono">⎇ {gitInfo.branch}{gitInfo.dirty ? ' ●' : ''}</span>
              )}
              {gitInfo && !gitInfo.isRepo && folder && (
                <span className="text-gray-500 font-normal">not a repo yet</span>
              )}
            </div>
            {!newMode && (
              <label className="block text-[12px] text-gray-400">
                Remote URL
                <input type="text" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              </label>
            )}
            <label className="block text-[12px] text-gray-400">
              Pinned branch <span className="text-gray-500">(tasks warn if checkout differs)</span>
              {branches.length > 0 ? (
                <select value={gitBranch} onChange={(e) => setGitBranch(e.target.value)}
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]">
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  {!branches.includes(gitBranch) && <option value={gitBranch}>{gitBranch}</option>}
                </select>
              ) : (
                <input type="text" value={gitBranch} onChange={(e) => setGitBranch(e.target.value)}
                  placeholder="main"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              )}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the project..." rows={3}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all resize-none" />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || !folderValid}
              className="btn btn-primary px-4 py-2.5 text-sm font-medium disabled:opacity-40">
              {project ? 'Save Changes' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
