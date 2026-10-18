import { Task, TaskPriority } from '../types';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquare, Pencil, Trash2, Loader2, AlertTriangle, Copy, Check, Play, RotateCcw } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { useState } from 'react';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task) => void;
  onMove?: (task: Task, status: Task['status']) => void;
  onRetry?: (task: Task) => void;
  isDeleting?: boolean;
}

const priorityConfig: Record<TaskPriority, { label: string; cls: string; dot: string }> = {
  low: { label: 'LOW', cls: 'p-green', dot: 'var(--emerald)' },
  medium: { label: 'MED', cls: 'p-blue', dot: 'var(--blue)' },
  high: { label: 'HIGH', cls: 'p-amber', dot: 'var(--amber)' },
  critical: { label: 'URGENT', cls: 'p-red', dot: 'var(--danger)' },
};

export default function TaskCard({ task, onEdit, onDelete, onOpenChat, onMove, onRetry, isDeleting }: TaskCardProps) {
  const isTemp = task.id.startsWith('temp-');
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
    disabled: isTemp,
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  const priority = priorityConfig[task.priority];
  const [copied, setCopied] = useState(false);
  const [copiedParent, setCopiedParent] = useState(false);

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

  const copyParent = async () => {
    if (!task.parentSessionId) return;
    try {
      await navigator.clipboard.writeText(task.parentSessionId);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = task.parentSessionId;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedParent(true);
    setTimeout(() => setCopiedParent(false), 1200);
  };

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={style}
      className={`task-card group relative mb-2 cursor-grab active:cursor-grabbing ${isDragging ? 'is-dragging z-50' : ''}`}
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

      {/* top meta row: mono ID + priority pill */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="inline-flex items-center gap-1 min-w-0">
          <span className="pill pill-id" title={task.id}>{task.id.slice(0, 8)}</span>
          <button onClick={(e) => { e.stopPropagation(); copyId(); }} onPointerDown={(e) => e.stopPropagation()} className="p-1 rounded hoverable shrink-0" title={copied ? 'Copied!' : `Copy full id ${task.id}`} aria-label="Copy task id">
            {copied ? <Check className="w-3 h-3" style={{ color: 'var(--emerald)' }} /> : <Copy className="w-3 h-3 muted" />}
          </button>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`pill ${priority.cls}`}>
            <span className="dot" style={{ background: priority.dot }} />
            {priority.label}
          </span>
          {task.pendingSync && (
            <span className="pill p-amber" title="Queued offline — syncs on reconnect">QUEUED</span>
          )}
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={(e) => { e.stopPropagation(); onEdit(task); }} onPointerDown={(e) => e.stopPropagation()} className="p-1 rounded hoverable" title="Edit task">
              <Pencil className="w-3 h-3 muted" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(task.id); }} onPointerDown={(e) => e.stopPropagation()} disabled={isDeleting} className="p-1 rounded hoverable disabled:opacity-50" title={isDeleting ? 'Deleting…' : 'Delete task'}>
              {isDeleting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Trash2 className="w-3 h-3 muted" />}
            </button>
          </span>
        </span>
      </div>

      <h4 className="text-[15px] font-medium t-strong leading-snug line-clamp-2">{task.title}</h4>
      {!!task.labels?.length && <div className="mt-2 flex flex-wrap gap-1" aria-label="Task labels">{task.labels.map((label) => <span key={label} className="pill p-neutral max-w-full truncate">{label}</span>)}</div>}
      {task.description && (
        <p className="text-[13px] muted mt-1 line-clamp-2 leading-snug">{task.description}</p>
      )}
      {task.acceptanceCriteria && (
        <p className="text-[11px] t-soft mt-1 line-clamp-2 leading-snug" title={task.acceptanceCriteria}>
          <strong>Accept:</strong> {task.acceptanceCriteria}
        </p>
      )}
      {task.result && (
        <div className="text-[12px] t-soft mt-1.5 leading-snug line-clamp-4 md-body overflow-hidden" title={task.resultContext ? `${task.result}\n\nContext: ${task.resultContext}` : task.result}>
          <Markdown remarkPlugins={[remarkGfm]}>{`✓ ${task.result}`}</Markdown>
        </div>
      )}
      {task.parentSessionId && (
        <p className="text-[11px] muted mt-1 mono flex items-center gap-1 min-w-0" title={`Created by session ${task.parentSessionId}`}>
          <span className="truncate">↳ from {task.parentSessionId.slice(0, 12)}…</span>
          <button onClick={(e) => { e.stopPropagation(); copyParent(); }} onPointerDown={(e) => e.stopPropagation()} className="p-0.5 rounded hoverable shrink-0" title={copiedParent ? 'Copied!' : `Copy parent session ${task.parentSessionId}`} aria-label="Copy parent session id">
            {copiedParent ? <Check className="w-3 h-3" style={{ color: 'var(--emerald)' }} /> : <Copy className="w-3 h-3 muted" />}
          </button>
        </p>
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
              <span className="line-clamp-3 flex-1">{task.startupError || 'Failed to start session'}</span>
              {onRetry && (
                <button onClick={(e) => { e.stopPropagation(); onRetry(task); }} onPointerDown={(e) => e.stopPropagation()} className="btn p-1 shrink-0" title="Retry start">
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-2 border-t hairline" style={{ borderTopStyle: 'solid', borderTopWidth: 1 }}>
        {(task.agentName || task.agentId) ? (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
              {(task.agentName || task.agentId || '?').charAt(0).toUpperCase()}
            </span>
            <span className="text-[13px] t-soft truncate" title={task.modelProviderID && task.modelId ? `model: ${task.modelProviderID}/${task.modelId}` : undefined}>
              {task.agentName || task.agentId}
              {task.modelProviderID && task.modelId && (
                <span className="muted mono"> · {task.modelProviderID}/{task.modelId}</span>
              )}
            </span>
          </span>
        ) : (
          <span className="text-[13px] muted">Unassigned</span>
        )}
        <span className="flex items-center gap-1">
          {task.status !== 'running' && onMove && (
            <button onClick={(e) => { e.stopPropagation(); onMove(task, 'running'); }} onPointerDown={(e) => e.stopPropagation()} className="btn p-1" title="Move to In Progress">
              <Play className="w-3 h-3" />
            </button>
          )}
        {task.status !== 'backlog' && task.sessionId ? (
          <button onClick={(e) => { e.stopPropagation(); onOpenChat(task); }} onPointerDown={(e) => e.stopPropagation()} className="btn p-1" title="Open agent chat">
            <MessageSquare className="w-3 h-3" />
          </button>
        ) : task.status !== 'backlog' && task.startupPhase === 'error' ? (
          <button onClick={(e) => { e.stopPropagation(); (onRetry ?? onOpenChat)(task); }} onPointerDown={(e) => e.stopPropagation()} className="btn p-1" title={`Retry start${task.startupError ? ` — ${task.startupError}` : ''}`} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
            <RotateCcw className="w-3 h-3" />
          </button>
        ) : null}
        </span>
      </div>
    </div>
  );
}
