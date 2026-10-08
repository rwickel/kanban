import { useState, useEffect, useRef } from 'react';
import { Project } from '../types';
import { X, FolderOpen } from 'lucide-react';

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { name: string; path: string; description: string }) => void;
  project?: Project | null;
}

export default function ProjectModal({ isOpen, onClose, onSave, project }: ProjectModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Native folder picker (File System Access API — Chrome/Edge).
  // Falls back to <input webkitdirectory> so plain file inputs still
  // give a Windows-style "Select Folder" dialog on other browsers.
  const supportsNativePicker =
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window;

  const handleBrowse = async () => {
    try {
      if (supportsNativePicker) {
        const dirHandle = await (window as any).showDirectoryPicker({
          mode: 'read',
        });
        // Browsers intentionally hide the full disk path (e.g. C:\...),
        // so the folder name is the most we can reliably display.
        setPath(dirHandle?.name ?? '');
      } else {
        folderInputRef.current?.click();
      }
    } catch (err) {
      // User cancelled the dialog — leave the current path untouched.
      if ((err as Error)?.name !== 'AbortError') {
        console.error('Folder picker failed:', err);
      }
    }
  };

  const handleFallbackFolderSelected = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // webkitRelativePath is like "MyFolder/sub/file.txt" — take the top folder.
      const topFolder = files[0].webkitRelativePath.split('/')[0];
      if (topFolder) setPath(topFolder);
    }
    // Reset so picking the same folder twice still fires onChange.
    e.target.value = '';
  };

  useEffect(() => {
    if (project) {
      setName(project.name);
      setPath(project.path);
      setDescription(project.description);
    } else {
      setName('');
      setPath('');
      setDescription('');
    }
  }, [project, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    onSave({ name: name.trim(), path: path.trim(), description: description.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-gray-100">
            {project ? 'Edit Project' : 'New Project'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all"
              autoFocus
            />
          </div>

          {/* Path — native Windows-style folder picker */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Project Path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/projects/my-app"
                className="flex-1 min-w-0 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all font-mono text-sm"
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm font-medium hover:bg-gray-700 hover:border-gray-600 transition-colors"
                title="Browse for folder"
              >
                <FolderOpen className="w-4 h-4" />
                Browse
              </button>
            </div>
            {/* Hidden directory input — fallback for browsers without showDirectoryPicker.
                webkitdirectory makes Chrome/Edge show a native "Select Folder" dialog on Windows,
                which looks and behaves exactly like the OS folder chooser. */}
            <input
              ref={folderInputRef}
              type="file"
              // @ts-expect-error — webkitdirectory is non-standard but widely supported
              webkitdirectory=""
              directory=""
              multiple
              onChange={handleFallbackFolderSelected}
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the project..."
              rows={3}
              className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:bg-gray-800 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-medium hover:from-violet-500 hover:to-purple-500 transition-all shadow-lg shadow-violet-500/20"
            >
              {project ? 'Save Changes' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
