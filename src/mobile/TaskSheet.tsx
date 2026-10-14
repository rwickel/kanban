import { Task, TaskStatus, TaskPriority } from '../types';
import { X, MessageSquare, Pencil, Trash2, Loader2, CheckCircle2, AlertOctagon, Inbox } from 'lucide-react';

const STATUSES: { status: TaskStatus; label: string; Icon: typeof Inbox }[] = [
  { status: 'backlog', label: 'Backlog', Icon: Inbox },
  { status: 'running', label: 'Running', Icon: Loader2 },
  { status: 'done', label: 'Done', Icon: CheckCircle2 },
  { status: 'blocked', label: 'Blocked', Icon: AlertOctagon },
];

const prioCls: Record<TaskPriority, string> = {
  low: 'p-green', medium: 'p-blue', high: 'p-amber', critical: 'p-red',
};

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="m-field">
      <span className="m-label">{label}</span>
      <div className="m-readonly">{value}</div>
    </div>
  );
}

export default function TaskSheet({
  task,
  onClose,
  onMove,
  onEdit,
  onDelete,
  onOpenChat,
}: {
  task: Task;
  onClose: () => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (t: Task) => void;
}) {
  return (
    <>
      <div className="m-scrim" onClick={onClose} />
      <section className="m-sheet" role="dialog" aria-label={`Task ${task.title}`}>
        <header className="m-overlay-head">
          <span className={`pill ${prioCls[task.priority]}`} style={{ fontSize: 10, padding: '2px 7px' }}>
            {task.priority === 'critical' ? 'URGENT' : task.priority.toUpperCase()}
          </span>
          <span className="m-overlay-title">{task.title || 'Untitled task'}</span>
          <button className="m-icon-btn" onClick={onClose} aria-label="Close task sheet">
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="m-overlay-body">
          <div className="m-field">
            <span className="m-label">Status</span>
            <div className="m-status-grid">
              {STATUSES.map(({ status, label, Icon }) => (
                <button
                  key={status}
                  className={`m-status-btn ${task.status === status ? 'is-active' : ''}`}
                  onClick={() => onMove(task, status)}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
                  {label}
                </button>
              ))}
            </div>
            <p className="m-hint">One tap moves the task. Drag and drop is not used on mobile.</p>
          </div>

          <Row label="Description" value={task.description} />
          <Row label="Assigned agent" value={task.agentName || task.agentId} />
          <Row label="Model" value={task.modelProviderID && task.modelId ? `${task.modelProviderID}/${task.modelId}` : task.modelId} />
          <Row label="Result" value={task.result} />
          <Row label="Result context" value={task.resultContext} />
          <Row label="Task id" value={task.id} />
          <Row label="Session id" value={task.sessionId} />

          {task.startupPhase === 'error' && (
            <div className="m-field">
              <span className="m-label">Startup error</span>
              <div className="m-readonly" style={{ color: 'var(--danger)' }}>{task.startupError}</div>
            </div>
          )}
        </div>

        <footer className="m-overlay-foot">
          <button
            className="m-btn"
            onClick={() => onOpenChat(task)}
            disabled={!task.sessionId}
            title={task.sessionId ? 'Open task chat' : 'Chat unavailable until the task is running'}
          >
            <MessageSquare className="w-4 h-4" strokeWidth={1.75} /> Chat
          </button>
          <button className="m-btn" onClick={() => onEdit(task)}>
            <Pencil className="w-4 h-4" strokeWidth={1.75} /> Edit
          </button>
          <button className="m-btn m-btn-danger" onClick={() => onDelete(task.id)}>
            <Trash2 className="w-4 h-4" strokeWidth={1.75} /> Delete
          </button>
        </footer>
      </section>
    </>
  );
}
