import { useEffect } from 'react';
import { Project } from '../types';
import { X, RefreshCw, FolderOpen, GitBranch } from 'lucide-react';
import { useProjectForm, ProjectFormData } from '../hooks/useProjectForm';
import ModelPoolPicker from './ModelPoolPicker';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: ProjectFormData) => void;
  project?: Project | null;
}

export default function ProjectModal({ isOpen, onClose, onSave, project }: ProjectModalProps) {
  const f = useProjectForm(project);

  useEffect(() => {
    if (!isOpen) return;
    f.reset(project);
    void f.loadRoots();
    void f.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || !f.effectiveFolder) return;
    if (!f.folderValid) return;
    onSave(f.toData());
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
            <input type="text" value={f.name} onChange={(e) => f.setName(e.target.value)}
              placeholder="My Awesome Project" autoFocus
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all" />
          </div>

          {/* Folder — only inside base path. Browsers cannot open an OS dialog
              at the server base path, so the server lists it instead. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-gray-300">
                Folder <span className="text-gray-500 font-normal">in {f.root || 'base path…'}</span>
              </label>
              <button type="button" onClick={() => { void f.loadRoots(); }} disabled={f.loading}
                className="p-1 rounded hoverable" title="Refresh folder list">
                <RefreshCw className={`w-3.5 h-3.5 muted ${f.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {f.error && <p className="text-[12px] text-red-400 mb-2">{f.error}</p>}
            {!f.newMode ? (
              <div className="flex gap-2">
                <select value={f.folder} onChange={(e) => f.setFolder(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50">
                  <option value="">Select folder…</option>
                  {f.folders.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
                <button type="button" onClick={() => { f.setNewMode(true); f.setNewFolder(''); }}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm font-medium hover:bg-gray-700 transition-colors"
                  title="Create a new folder under the base path">
                  <FolderOpen className="w-4 h-4" /> New
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input type="text" value={f.newFolder} onChange={(e) => f.setNewFolder(e.target.value)}
                  placeholder="my-new-project"
                  className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50" />
                <button type="button" onClick={() => { f.setNewMode(false); f.setNewFolder(''); }}
                  className="shrink-0 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm hover:bg-gray-700">
                  Existing
                </button>
              </div>
            )}
            {f.effectiveFolder && !f.folderValid && (
              <p className="text-[11px] text-amber-400 mt-1.5">
                Only letters/digits plus <span className="mono">._-</span>, max 64 chars, no slashes or spaces.
              </p>
            )}
            {f.resolvedPath && f.folderValid && (
              <p className="text-[11px] text-gray-500 mt-1.5 font-mono break-all">
                → {f.resolvedPath}
                {f.isNewOutsideList && <span className="text-violet-400"> (will be created)</span>}
              </p>
            )}
            {f.newMode && (
              <label className="block text-[12px] text-gray-400 mt-2">
                Clone URL <span className="text-gray-500">(optional — clones into the new folder)</span>
                <input type="text" value={f.cloneUrl} onChange={(e) => f.setCloneUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              </label>
            )}
          </div>

          {/* Git — link repo + pinned branch */}
          <div className="rounded-xl border border-gray-700 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-gray-300">
              <GitBranch className="w-3.5 h-3.5" /> Git
              {f.gitInfo?.isRepo && f.gitInfo.branch && (
                <span className="pill p-neutral mono">⎇ {f.gitInfo.branch}{f.gitInfo.dirty ? ' ●' : ''}</span>
              )}
              {f.gitInfo && !f.gitInfo.isRepo && f.folder && (
                <span className="text-gray-500 font-normal">not a repo yet</span>
              )}
            </div>
            {!f.newMode && (
              <label className="block text-[12px] text-gray-400">
                Remote URL
                <input type="text" value={f.gitUrl} onChange={(e) => f.setGitUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              </label>
            )}
            <label className="block text-[12px] text-gray-400">
              Pinned branch <span className="text-gray-500">(tasks warn if checkout differs)</span>
              {f.branches.length > 0 ? (
                <select value={f.gitBranch} onChange={(e) => f.setGitBranch(e.target.value)}
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]">
                  {f.branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                  {!f.branches.includes(f.gitBranch) && <option value={f.gitBranch}>{f.gitBranch}</option>}
                </select>
              ) : (
                <input type="text" value={f.gitBranch} onChange={(e) => f.setGitBranch(e.target.value)}
                  placeholder="main"
                  className="mt-1 w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 font-mono text-[12px]" />
              )}
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Description</label>
            <textarea value={f.description} onChange={(e) => f.setDescription(e.target.value)}
              placeholder="Brief description of the project..." rows={3}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all resize-none" />
          </div>

          {/* Models usable in this project — provider list + model checkboxes.
              Empty selection = no restriction (every server model). */}
          <ModelPoolPicker
            models={f.models}
            selected={f.allowedModels}
            onChange={f.setAllowedModels}
            loading={f.modelsLoading}
            error={f.modelsError}
            onRefresh={() => { void f.loadModels(); }}
          />

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!f.name.trim() || !f.folderValid}
              className="btn btn-primary px-4 py-2.5 text-sm font-medium disabled:opacity-40">
              {project ? 'Save Changes' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
