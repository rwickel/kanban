import { useEffect, useState } from 'react';
import { Project } from '../types';
import { FolderOpen, GitBranch, RefreshCw, X } from 'lucide-react';
import {
  setActiveProjectId as persistActiveProjectId,
  deleteProject,
  saveProject,
} from '../store/kanban';
import { useProjectForm } from '../hooks/useProjectForm';

export function ProjectDialog({
  project,
  onClose,
  onReload,
}: {
  project?: Project | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const f = useProjectForm(project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    f.reset(project);
    setBusy(false);
    setError(null);
    void f.loadRoots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const remove = async () => {
    if (!project) return;
    const ok = await confirmDeleteProject(project);
    if (ok) {
      await onReload();
      onClose();
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim() || !f.folderValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveProject(f.toData(), project?.id ?? null);
      if (!project && saved) persistActiveProjectId(saved.id);
      await onReload();
      onClose();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setBusy(false);
    }
  };

  return (
    <div className="m-full" role="dialog" aria-label={project ? 'Edit project' : 'New project'}>
      <header className="m-overlay-head">
        <span className="m-overlay-title">{project ? 'Edit project' : 'New project'}</span>
        <button className="m-icon-btn" onClick={onClose} aria-label="Close project dialog">
          <X className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </header>
      <form onSubmit={save} className="m-overlay-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="m-field">
          <label className="m-label" htmlFor="mp-name">Name</label>
          <input id="mp-name" className="input" value={f.name} onChange={(e) => f.setName(e.target.value)}
            placeholder="Project name" autoFocus />
        </div>
        <div className="m-field">
          <div className="flex items-center justify-between">
            <label className="m-label" htmlFor="mp-folder" style={{ marginBottom: 0 }}>
              Folder{f.root ? <span className="muted"> in {f.root}</span> : null}
            </label>
            <button type="button" className="m-icon-btn" style={{ width: 32, height: 32, minHeight: 32 }} onClick={() => { void f.loadRoots(); }} disabled={f.loading} aria-label="Refresh folder list">
              <RefreshCw className={`w-4 h-4 ${f.loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            </button>
          </div>
          {f.error && <p className="m-hint" style={{ color: 'var(--danger)' }}>{f.error}</p>}
          {!f.newMode ? (
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              <select
                id="mp-folder"
                className="input mono"
                style={{ flex: '1 1 auto', minWidth: 0 }}
                value={f.folder}
                onChange={(e) => f.setFolder(e.target.value)}
              >
                <option value="">Select folder…</option>
                {f.folders.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
                {f.folder && !f.folders.includes(f.folder) && <option value={f.folder}>{f.folder}</option>}
              </select>
              <button type="button" className="m-btn" style={{ minHeight: 44 }} onClick={() => { f.setNewMode(true); f.setNewFolder(''); }} title="Create a new folder under the base path">
                <FolderOpen className="w-4 h-4" strokeWidth={1.75} /> New
              </button>
            </div>
          ) : (
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              <input
                className="input mono"
                style={{ flex: '1 1 auto', minWidth: 0 }}
                value={f.newFolder}
                onChange={(e) => f.setNewFolder(e.target.value)}
                placeholder="my-new-project"
              />
              <button type="button" className="m-btn" style={{ minHeight: 44 }} onClick={() => { f.setNewMode(false); f.setNewFolder(''); }}>
                Existing
              </button>
            </div>
          )}
          {f.effectiveFolder && !f.folderValid && (
            <p className="m-hint" style={{ color: 'var(--amber)' }}>
              Only letters/digits plus ._- — max 64 chars, no slashes or spaces.
            </p>
          )}
          {f.resolvedPath && f.folderValid && (
            <p className="m-hint mono" style={{ wordBreak: 'break-all' }}>
              → {f.resolvedPath}
              {f.isNewOutsideList && <span> (will be created)</span>}
            </p>
          )}
          {f.newMode && (
            <div className="m-field" style={{ marginTop: 8, marginBottom: 0 }}>
              <label className="m-label" htmlFor="mp-clone">Clone URL <span className="muted">(optional — clones into the new folder)</span></label>
              <input id="mp-clone" className="input mono" value={f.cloneUrl} onChange={(e) => f.setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git" />
            </div>
          )}
        </div>

        <div className="m-field">
          <p className="m-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <GitBranch className="w-4 h-4" strokeWidth={1.75} /> Git
            {f.gitInfo?.isRepo && f.gitInfo.branch && (
              <span className="pill p-neutral mono">⎇ {f.gitInfo.branch}{f.gitInfo.dirty ? ' ●' : ''}</span>
            )}
            {f.gitInfo && !f.gitInfo.isRepo && f.folder && !f.newMode && (
              <span className="muted">not a repo yet</span>
            )}
          </p>
          {!f.newMode && (
            <div className="m-field" style={{ marginBottom: 8 }}>
              <label className="m-label" htmlFor="mp-remote">Remote URL</label>
              <input id="mp-remote" className="input mono" value={f.gitUrl} onChange={(e) => f.setGitUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git" />
            </div>
          )}
          <label className="m-label" htmlFor="mp-branch">Pinned branch <span className="muted">(tasks warn if checkout differs)</span></label>
          {f.branches.length > 0 ? (
            <select id="mp-branch" className="input mono" value={f.gitBranch} onChange={(e) => f.setGitBranch(e.target.value)}>
              {f.branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
              {!f.branches.includes(f.gitBranch) && <option value={f.gitBranch}>{f.gitBranch}</option>}
            </select>
          ) : (
            <input id="mp-branch" className="input mono" value={f.gitBranch} onChange={(e) => f.setGitBranch(e.target.value)}
              placeholder="main" />
          )}
        </div>

        <div className="m-field">
          <label className="m-label" htmlFor="mp-desc">Description</label>
          <textarea id="mp-desc" className="input resize-none" rows={3} value={f.description}
            onChange={(e) => f.setDescription(e.target.value)} placeholder="Optional description" />
        </div>
        {error && <p className="m-hint" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="m-overlay-foot">
          {project && (
            <button type="button" className="m-btn m-btn-danger" onClick={remove}>Delete</button>
          )}
          <button type="button" className="m-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="m-btn m-btn-primary" disabled={busy || !f.name.trim() || !f.folderValid}>
            {busy ? 'Saving…' : project ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

export async function confirmDeleteProject(project: Project): Promise<boolean> {
  if (!window.confirm(`Delete "${project.name}" and all its tasks?`)) return false;
  await deleteProject(project.id);
  return true;
}
