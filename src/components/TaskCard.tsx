import { Task, TaskPriority } from '../types';
import { MessageSquare, Pencil, Trash2, GripVertical, Loader2, AlertTriangle, Copy, Check } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { useState } from 'react';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task) => void;
  isDeleting?: boolean;
}

const priorityConfig: Record<TaskPriority, { label: string; cls: string; dot: string }> = {
  low: { label: 'LOW', cls: 'p-green', dot: 'var(--emerald)' },
  medium: { label: 'MED', cls: 'p-blue', dot: 'var(--blue)' },
  high: { label: 'HIGH', cls: 'p-amber', dot: 'var(--amber)' },
  critical: { label: 'URGENT', cls: 'p-red', dot: 'var(--danger)' },
};

export default function TaskCard({ task, onEdit, onDelete, onOpenChat, isDeleting }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  const priority = priorityConfig[task.priority];
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(task.id);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = task.id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-card group relative mb-2 ${isDragging ? 'is-dragging z-50' : ''}`}
      aria-busy={isDeleting || undefined}
    >
      {/* deleting overlay: spinner — the Python CLI write can take seconds */}
      {isDeleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2"
          style={{ background: 'color-mix(in srgb, var(--surface) 72%, transparent)', borderRadius: 'inherit' }}>
          <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
          <span className="text-[12px] t-soft mono">Deleting…</span>
        </div>
      )}
      <div
        {...attributes}
        {...listeners}
        className="absolute left-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
      >
        <GripVertical className="w-3 h-3 muted" />
      </div>

      {/* top meta row: mono ID + priority pill */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="inline-flex items-center gap-1 min-w-0">
          <span className="pill pill-id" title={task.id}>{task.id.slice(0, 8)}</span>
          <button onClick={copyId} className="p-1 rounded hoverable shrink-0" title={copied ? 'Copied!' : `Copy full id ${task.id}`} aria-label="Copy task id">
            {copied ? <Check className="w-3 h-3" style={{ color: 'var(--emerald)' }} /> : <Copy className="w-3 h-3 muted" />}
          </button>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`pill ${priority.cls}`}>
            <span className="dot" style={{ background: priority.dot }} />
            {priority.label}
          </span>
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onEdit(task)} className="p-1 rounded hoverable" title="Edit task">
              <Pencil className="w-3 h-3 muted" />
            </button>
            <button onClick={() => onDelete(task.id)} disabled={isDeleting} className="p-1 rounded hoverable disabled:opacity-50" title={isDeleting ? 'Deleting…' : 'Delete task'}>
              {isDeleting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Trash2 className="w-3 h-3 muted" />}
            </button>
          </span>
        </span>
      </div>

      <h4 className="text-[15px] font-medium t-strong leading-snug line-clamp-2">{task.title}</h4>
      {task.description && (
        <p className="text-[13px] muted mt-1 line-clamp-2 leading-snug">{task.description}</p>
      )}

      {/* startup state: visible progress / error for running tasks */}
      {task.status === 'running' && task.startupPhase && task.startupPhase !== 'ready' && (
        <div className="mt-2 rounded-md px-2 py-1.5 text-[12px] leading-snug"
          style={task.startupPhase === 'error'
            ? { background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)', border: '1px solid var(--danger)' }
            : { background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
          {task.startupPhase === 'creating-session' && (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Creating session…
            </span>
          )}
          {task.startupPhase === 'sending-prompt' && (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Sending prompt…
            </span>
          )}
          {task.startupPhase === 'error' && (
            <span className="flex items-start gap-1.5" title={task.startupError}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span className="line-clamp-3">{task.startupError || 'Failed to start session'}</span>
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-2 border-t hairline" style={{ borderTopStyle: 'solid', borderTopWidth: 1 }}>
        {task.agentName ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
              {task.agentName.charAt(0).toUpperCase()}
            </span>
            <span className="text-[13px] t-soft truncate" title={task.modelProviderID && task.modelId ? `model: ${task.modelProviderID}/${task.modelId}` : undefined}>
              {task.agentName}
              {task.modelProviderID && task.modelId && (
                <span className="muted mono"> · {task.modelProviderID}/{task.modelId}</span>
              )}
            </span>
          </span>
        ) : (
          <span className="text-[13px] muted">Unassigned</span>
        )}
        {task.sessionId ? (
          <button onClick={() => onOpenChat(task)} className="btn p-1" title="Open agent chat">
            <MessageSquare className="w-3 h-3" />
          </button>
        ) : task.startupPhase === 'error' ? (
          <button onClick={() => onOpenChat(task)} className="btn p-1" title={task.startupError || 'Open — startup failed'} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            <AlertTriangle className="w-3 h-3" />
          </button>
        ) : task.agentId ? (
          <button onClick={() => onOpenChat(task)} className="btn p-1" title={task.startupPhase ? 'Starting session…' : 'Start session & open chat'}>
            {task.startupPhase ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}
