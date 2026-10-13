import { useState } from 'react';
import { Project } from '../types';
import { X } from 'lucide-react';
import {
  setActiveProjectId as persistActiveProjectId,
  createProject,
  updateProject,
  deleteProject,
} from '../store/kanban';

export function ProjectDialog({
  project,
  onClose,
  onReload,
}: {
  project?: Project | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [folder, setFolder] = useState(project?.folder ?? project?.path ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (project) {
        await updateProject(project.id, { name: name.trim(), folder: folder.trim(), description: description.trim() });
      } else {
        const np = await createProject(name.trim(), folder.trim(), description.trim());
        persistActiveProjectId(np.id);
      }
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
          <input id="mp-name" className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Project name" autoFocus />
        </div>
        <div className="m-field">
          <label className="m-label" htmlFor="mp-folder">Folder</label>
          <input id="mp-folder" className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)}
            placeholder="Folder name or absolute path" />
        </div>
        <div className="m-field">
          <label className="m-label" htmlFor="mp-desc">Description</label>
          <textarea id="mp-desc" className="input resize-none" rows={3} value={description}
            onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
        </div>
        {error && <p className="m-hint" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="m-overlay-foot">
          {project && (
            <button type="button" className="m-btn m-btn-danger" onClick={remove}>Delete</button>
          )}
          <button type="button" className="m-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="m-btn m-btn-primary" disabled={busy}>
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
