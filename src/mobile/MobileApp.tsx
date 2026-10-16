import { useState } from 'react';
import { Task, TaskStatus, Project } from '../types';
import { useTheme } from '../hooks/useTheme';
import { useBoardData } from './useBoardData';
import ColumnTabs from './ColumnTabs';
import MobileCard from './MobileCard';
import TaskSheet from './TaskSheet';
import MobileTaskForm, { MobileTaskFormData } from './MobileTaskForm';
import MobileChat from './MobileChat';
import MobileHeader from './MobileHeader';
import { ProjectDialog } from './MobileMenu';
import ServerConfigModal from '../components/ServerConfigModal';
import AgentTeamModal from '../components/AgentTeamModal';
import OfflineBanner from '../components/OfflineBanner';
import { updateProject } from '../store/kanban';
import { Plus, FolderKanban, MessageSquare } from 'lucide-react';
import './mobile.css';

export default function MobileApp() {
  const { theme, toggle } = useTheme();
  const {
    projects, activeProject, availableAgents,
    tasks, isConnected, deletingIds,
    offline, queued, replaying, refreshSyncState, replayQueue,
    loadData, handleMove, handleSave, handleDelete,
    handleSwitchProject,
  } = useBoardData();

  const [activeStatus, setActiveStatus] = useState<TaskStatus>('backlog');
  const [sheetTask, setSheetTask] = useState<Task | null>(null);
  const [chatTask, setChatTask] = useState<Task | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [formEditing, setFormEditing] = useState<Task | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<Project | null | 'new'>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  const counts: Record<TaskStatus, number> = {
    backlog: tasks.backlog.length,
    running: tasks.running.length,
    done: tasks.done.length,
    blocked: tasks.blocked.length,
  };
  const PRIO_ORDER: Record<Task['priority'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const visible = [...tasks[activeStatus]].sort((a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]);

  const closeOverlays = () => {
    setSheetTask(null);
    setChatTask(null);
    setAssistantOpen(false);
  };

  const openForm = (t?: Task) => {
    setSheetTask(null);
    setFormEditing(t ?? null);
    setFormOpen(true);
  };

  return (
    <div className="m-root">
      <MobileHeader
        project={activeProject}
        projects={projects}
        isConnected={isConnected}
        theme={theme}
        onToggleTheme={toggle}
        onSwitchProject={(id) => { void handleSwitchProject(id); }}
        onNewProject={() => setProjectDialog('new')}
        onEditProject={(p) => setProjectDialog(p)}
        onOpenServer={() => setServerOpen(true)}
        onOpenTeam={() => setTeamOpen(true)}
        onOpenSettings={() => { window.location.href = '/settings?from=mobile'; }}
      />

      {(offline || queued > 0) && (
        <div className="m-offline-wrap">
          <OfflineBanner
            offline={offline}
            queued={queued}
            retrying={replaying}
            onRetry={() => {
              void (async () => {
                await replayQueue();
                await loadData().catch((e) => { console.warn('refresh skipped (server down)', e); });
                refreshSyncState();
              })();
            }}
          />
        </div>
      )}

      <div className="m-body">
        <ColumnTabs
          counts={counts}
          active={activeStatus}
          onChange={(s) => { setAssistantOpen(false); setChatTask(null); setActiveStatus(s); }}
        />

        {!activeProject ? (
          <div
            className="m-board"
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}
          >
            <div className="panel" style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderKanban className="w-5 h-5 muted" strokeWidth={1.5} />
            </div>
            <p className="muted" style={{ fontSize: 13, textAlign: 'center' }}>
              Create a project to get started. Delegate work from the assistant chat.
            </p>
            <button className="m-btn m-btn-primary" onClick={() => setProjectDialog('new')}>
              <Plus className="w-4 h-4" strokeWidth={1.75} /> Create project
            </button>
          </div>
        ) : (
          <main className="m-board">
            <div className="m-column-head">
              <span className="pill p-neutral" style={{ fontSize: 11 }}>{activeStatus.toUpperCase()}</span>
              <span className="muted mono" style={{ fontSize: 12 }}>
                {visible.length} task{visible.length === 1 ? '' : 's'}
              </span>
            </div>
            {visible.length === 0 ? (
              <div className="m-empty">
                No tasks in {activeStatus}. Tap + to create one, or delegate from the assistant chat.
              </div>
            ) : (
              visible.map((t) => (
                <MobileCard
                  key={t.id}
                  task={t}
                  onOpen={setSheetTask}
                  onEdit={openForm}
                  onDelete={(id) => { void handleDelete(id); }}
                  onMove={(t) => { void handleMove(t, 'running'); }}
                  onOpenChat={(x) => { setSheetTask(null); setChatTask(x); }}
                  isDeleting={deletingIds.has(t.id)}
                />
              ))
            )}
          </main>
        )}
      </div>

      {activeProject && (
        <>
          <button className="m-fab m-fab-assist" onClick={() => { setSheetTask(null); setChatTask(null); setAssistantOpen(true); }} aria-label="Board assistant chat">
            <MessageSquare className="w-6 h-6" strokeWidth={2} />
          </button>
          <button className="m-fab" onClick={() => openForm()} aria-label="New task">
            <Plus className="w-6 h-6" strokeWidth={2} />
          </button>
        </>
      )}

      {sheetTask && (
        <TaskSheet
          task={sheetTask}
          onClose={() => setSheetTask(null)}
          onMove={(t, s) => { setSheetTask(null); void handleMove(t, s); }}
          onEdit={openForm}
          onDelete={(id) => { setSheetTask(null); void handleDelete(id); }}
          onOpenChat={(t) => { setSheetTask(null); setChatTask(t); }}
        />
      )}

      {formOpen && (
        <MobileTaskForm
          task={formEditing}
          availableAgents={availableAgents}
          allowedModels={activeProject?.allowedModels}
          onClose={() => { setFormOpen(false); setFormEditing(null); }}
          onSave={(data: MobileTaskFormData) => {
            void handleSave(data, formEditing ?? undefined);
            setFormEditing(null);
          }}
        />
      )}

      {(chatTask || assistantOpen) && (
        <MobileChat task={chatTask} project={chatTask ? null : activeProject} availableAgents={availableAgents} onBack={closeOverlays} />
      )}

      {projectDialog !== null && (
        <ProjectDialog
          project={projectDialog === 'new' ? null : projectDialog}
          onClose={() => setProjectDialog(null)}
          onReload={loadData}
        />
      )}

      {serverOpen && (
        <ServerConfigModal
          isOpen
          onClose={() => setServerOpen(false)}
          onConnected={() => loadData()}
        />
      )}

      {teamOpen && activeProject && (
        <AgentTeamModal
          isOpen
          onClose={() => setTeamOpen(false)}
          onSave={(agentIds: string[]) => {
            void (async () => {
              await updateProject(activeProject.id, { agentIds });
              await loadData();
              setTeamOpen(false);
            })();
          }}
          selectedAgentIds={activeProject.agentIds || []}
        />
      )}
    </div>
  );
}
