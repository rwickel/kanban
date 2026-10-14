import { useEffect, useState } from 'react';
import { FolderGitInfo, Project } from '../types';
import { getFolderGit, getRoots } from '../store/kanban';

export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ProjectFormData {
  name: string;
  folder: string;
  description: string;
  gitUrl?: string;
  gitBranch?: string;
  mkdir?: boolean;
}

/** Shared project form state + folder/git loading. One config, desktop + mobile. */
export function useProjectForm(project?: Project | null) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [root, setRoot] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState(project?.folder ?? '');
  const [newMode, setNewMode] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [gitUrl, setGitUrl] = useState(project?.gitUrl ?? '');
  const [cloneUrl, setCloneUrl] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [gitBranch, setGitBranch] = useState(project?.gitBranch ?? 'main');
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

  const reset = (p?: Project | null) => {
    setName(p?.name ?? '');
    setDescription(p?.description ?? '');
    setFolder(p?.folder ?? '');
    setGitUrl(p?.gitUrl ?? '');
    setGitBranch(p?.gitBranch ?? 'main');
    setNewMode(false);
    setNewFolder('');
    setCloneUrl('');
    setGitInfo(null);
    setBranches([]);
    setError(null);
  };

  // Load git info when folder selection changes.
  useEffect(() => {
    if (!folder || newMode) {
      setGitInfo(null);
      setBranches([]);
      return;
    }
    let live = true;
    getFolderGit(folder).then((info) => {
      if (!live || !info) return;
      setGitInfo(info);
      if (info.isRepo) {
        const list = info.branches?.length ? info.branches : info.branch ? [info.branch] : [];
        setBranches(list);
        if (info.branch) setGitBranch((b) => (b === 'main' || !b ? info.branch! : b));
        if (info.remote) setGitUrl((g) => g || info.remote || '');
      } else {
        setBranches([]);
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, newMode]);

  const effectiveFolder = newMode ? newFolder.trim() : folder;
  const folderValid = FOLDER_RE.test(effectiveFolder);
  const isNewOutsideList = newMode && effectiveFolder !== '' && !folders.includes(effectiveFolder);
  const resolvedPath =
    effectiveFolder && root
      ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${effectiveFolder}`
      : '';

  const toData = (): ProjectFormData => ({
    name: name.trim(),
    folder: effectiveFolder,
    description: description.trim(),
    gitUrl: (newMode ? cloneUrl.trim() : gitUrl.trim()) || undefined,
    gitBranch: gitBranch.trim() || 'main',
    mkdir: newMode,
  });

  return {
    name, setName,
    description, setDescription,
    root, folders, folder, setFolder,
    newMode, setNewMode, newFolder, setNewFolder,
    gitUrl, setGitUrl, cloneUrl, setCloneUrl,
    branches, gitBranch, setGitBranch, gitInfo,
    loading, error, loadRoots, reset,
    effectiveFolder, folderValid, isNewOutsideList, resolvedPath,
    toData,
  };
}

export type ProjectForm = ReturnType<typeof useProjectForm>;
