import { useState } from 'react';
import { Project } from '../types';
import { LayoutGrid, X, Wifi, WifiOff, Moon, Sun, FolderKanban, Plus, Settings, Users, Server, Monitor, SlidersHorizontal } from 'lucide-react';

export default function MobileHeader({
  project,
  projects,
  isConnected,
  theme,
  onToggleTheme,
  onSwitchProject,
  onNewProject,
  onEditProject,
  onOpenServer,
  onOpenTeam,
  onOpenSettings,
}: {
  project: Project | null;
  projects: Project[];
  isConnected: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onSwitchProject: (id: string) => void;
  onNewProject: () => void;
  onEditProject: (p: Project) => void;
  onOpenServer: () => void;
  onOpenTeam: () => void;
  onOpenSettings: () => void;
}) {
  const [drawer, setDrawer] = useState(false);
  const close = () => setDrawer(false);

  const item = (label: string, Icon: typeof Settings, onClick: () => void) => (
    <button className="m-menu-item" onClick={() => { onClick(); close(); }}>
      <Icon className="w-4 h-4" strokeWidth={1.75} />
      <span>{label}</span>
    </button>
  );

  return (
    <header className="m-topbar">
      <div className="m-topbar-row">
        <div className="m-brand">
          <button className="m-logo-btn" onClick={() => setDrawer(true)} aria-label="Open menu" title="Open menu">
            <span className="m-logo"><LayoutGrid className="w-4 h-4" strokeWidth={1.75} /></span>
          </button>
          <span style={{ minWidth: 0 }}>
            <span className="m-project-name">{project?.name ?? 'Select project'}</span>
            <span className="m-project-sub">
              {isConnected ? 'CONNECTED' : 'DEMO'} · {projects.length} project{projects.length === 1 ? '' : 's'}
            </span>
          </span>
        </div>
        <span className={`pill ${isConnected ? 'p-green' : 'p-amber'}`}>
          {isConnected ? <Wifi className="w-3 h-3" strokeWidth={1.75} /> : <WifiOff className="w-3 h-3" strokeWidth={1.75} />}
        </span>
        <button className="m-icon-btn" onClick={onToggleTheme} aria-label="Toggle theme">
          {theme === 'light' ? <Moon className="w-4 h-4" strokeWidth={1.75} /> : <Sun className="w-4 h-4" strokeWidth={1.75} />}
        </button>
      </div>

      {drawer && (
        <>
          <div className="m-scrim" onClick={close} />
          <nav className="m-drawer" aria-label="Menu">
            <div className="m-drawer-head">
              <strong className="text-[14px]">Menu</strong>
              <button className="m-icon-btn" onClick={close} aria-label="Close menu">
                <X className="w-4 h-4" strokeWidth={1.75} />
              </button>
            </div>
            <div className="m-drawer-body">
              <p className="m-menu-group">Project</p>
              {projects.map((p) => (
                <button key={p.id} className="m-menu-item" onClick={() => { onSwitchProject(p.id); close(); }}
                  style={p.id === project?.id ? { background: 'var(--surface-2)' } : undefined}>
                  <FolderKanban className="w-4 h-4" strokeWidth={1.75} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                </button>
              ))}
              {item('New project', Plus, onNewProject)}
              {project && item('Edit project', Settings, () => onEditProject(project))}

              <div className="m-menu-sep" />

              <p className="m-menu-group">Settings</p>
              {item('Preferences', SlidersHorizontal, onOpenSettings)}
              {item('Agent team', Users, onOpenTeam)}
              {item('Server connection', Server, onOpenServer)}
              {item('Desktop view', Monitor, () => { window.location.href = '/'; })}

              <div className="m-menu-sep" />
              <p className="m-hint">Open the desktop board at <span className="mono">/</span>. This view is at <span className="mono">/m</span>.</p>
            </div>
          </nav>
        </>
      )}
    </header>
  );
}
