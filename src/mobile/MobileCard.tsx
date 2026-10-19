import { Task, TaskPriority } from '../types';
import { MessageSquare, Pencil, Trash2, Loader2, AlertTriangle, Play } from 'lucide-react';
import { formatDueDate, isOverdue } from '../dueDate';

const prioCls: Record<TaskPriority, string> = {
  low: 'p-green', medium: 'p-blue', high: 'p-amber', critical: 'p-red',
};

export default function MobileCard({
  task,
  onOpen,
  onEdit,
  onDelete,
  onOpenChat,
  onMove,
  isDeleting,
}: {
  task: Task;
  onOpen: (t: Task) => void;
  onEdit: (t: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (t: Task) => void;
  onMove: (t: Task) => void;
  isDeleting?: boolean;
}) {
  const busy = task.startupPhase === 'creating-session' || task.startupPhase === 'sending-prompt';
  const failed = task.startupPhase === 'error';

  return (
    <div className="m-card" role="group" aria-label={task.title}>
      <button
        onClick={() => onOpen(task)}
        style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
      >
        <div className="m-card-top">
          <span className={`pill ${prioCls[task.priority]}`} style={{ fontSize: 10, padding: '2px 7px' }}>
            {task.priority === 'critical' ? 'URGENT' : task.priority.toUpperCase()}
          </span>
          {task.agentName && (
            <span className="pill p-neutral" style={{ fontSize: 10, padding: '2px 7px' }}>{task.agentName}</span>
          )}
          {busy && (
            <span className="pill p-amber" style={{ fontSize: 10, padding: '2px 7px' }}>
              <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} /> starting
            </span>
          )}
          {task.pendingSync && (
            <span className="pill p-amber" style={{ fontSize: 10, padding: '2px 7px' }} title="Queued offline — syncs on reconnect">QUEUED</span>
          )}
          {failed && (
            <span className="pill p-red" style={{ fontSize: 10, padding: '2px 7px' }}>
              <AlertTriangle className="w-3 h-3" strokeWidth={1.75} /> failed
            </span>
          )}
        </div>
        <p className="m-card-title">{task.title || 'Untitled task'}</p>
        {task.dueDate && <p className={`m-card-desc ${isOverdue(task.dueDate) && task.status !== 'done' ? 'due-overdue' : ''}`}>{isOverdue(task.dueDate) && task.status !== 'done' ? 'Overdue' : 'Due'} {formatDueDate(task.dueDate)}</p>}
        {task.description && <p className="m-card-desc">{task.description}</p>}
        {task.acceptanceCriteria && <p className="m-card-desc"><strong>Accept:</strong> {task.acceptanceCriteria}</p>}
      </button>
      <div className="m-card-actions">
        {task.status !== 'running' && (
          <button className="m-icon-btn" onClick={() => onMove(task)} aria-label="Move task to running" title="Move to running">
            <Play className="w-4 h-4" strokeWidth={1.75} />
          </button>
        )}
        {task.status !== 'backlog' && task.sessionId && (
          <button className="m-icon-btn" onClick={() => onOpenChat(task)} aria-label="Open agent chat">
            <MessageSquare className="w-4 h-4" strokeWidth={1.75} />
          </button>
        )}
        <button className="m-icon-btn" onClick={() => onEdit(task)} aria-label="Edit task">
          <Pencil className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button className="m-icon-btn" onClick={() => onDelete(task.id)} disabled={isDeleting} aria-label="Delete task">
          <Trash2 className="w-4 h-4" strokeWidth={1.75} style={isDeleting ? { opacity: 0.5 } : undefined} />
        </button>
      </div>
    </div>
  );
}
