import { Task, TaskPriority } from '../types';
import { MessageSquare, Edit2, Trash2, GripVertical, Play, Circle } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task) => void;
  onStartTask?: (task: Task) => void;
}

const priorityConfig: Record<TaskPriority, { color: string; label: string; dot: string }> = {
  low: { color: 'text-slate-500', label: 'Low', dot: 'bg-slate-400' },
  medium: { color: 'text-blue-600', label: 'Med', dot: 'bg-blue-500' },
  high: { color: 'text-amber-600', label: 'High', dot: 'bg-amber-500' },
  critical: { color: 'text-red-600', label: 'Urgent', dot: 'bg-red-500' },
};

export default function TaskCard({ task, onEdit, onDelete, onOpenChat, onStartTask }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  const priority = priorityConfig[task.priority];
  const isBacklog = task.status === 'backlog';
  const canStart = isBacklog && task.agentId && onStartTask;

  // Generate a deterministic issue ID from the task id
  const issueId = `ENG-${task.id.slice(0, 3).toUpperCase()}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative bg-white border border-slate-200 rounded-[6px] p-2.5 mb-2 transition-all duration-150 hover:border-slate-300 ${
        isDragging ? 'shadow-drag opacity-90 z-50' : 'hover:shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
      }`}
    >
      {/* Top row: issue ID + priority dot */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[10px] text-slate-500 tracking-tight">
          {issueId}
        </span>
        <div className="flex items-center gap-0.5">
          <span className={`w-1.5 h-1.5 rounded-full ${priority.dot}`} title={priority.label} />
          <span className={`text-[10px] font-medium ${priority.color}`}>{priority.label}</span>
        </div>
      </div>

      {/* Title */}
      <h4 className="text-[13px] font-medium text-slate-900 leading-snug mb-1 line-clamp-2">
        {task.title}
      </h4>

      {/* Description */}
      {task.description && (
        <p className="text-[11px] text-slate-500 leading-relaxed mb-2 line-clamp-2">
          {task.description}
        </p>
      )}

      {/* Footer: agent bubble + actions */}
      <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
        {task.agentName ? (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-[3px] flex items-center justify-center text-[9px] font-bold text-white"
              style={{ backgroundColor: '#6366f1' }}>
              {task.agentName.charAt(0).toUpperCase()}
            </div>
            <span className="text-[11px] text-slate-600 font-medium">{task.agentName}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-[3px] bg-slate-100 border border-slate-200 flex items-center justify-center">
              <Circle className="w-2 h-2 text-slate-300" />
            </div>
            <span className="text-[11px] text-slate-400">Unassigned</span>
          </div>
        )}

        {/* Action buttons - visible on hover */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {canStart && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartTask(task); }}
              className="p-1 rounded-[3px] hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors"
              title="Start task (⌘↵)"
            >
              <Play className="w-3 h-3" />
            </button>
          )}
          {task.sessionId && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenChat(task); }}
              className="p-1 rounded-[3px] hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
              title="Open chat"
            >
              <MessageSquare className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(task); }}
            className="p-1 rounded-[3px] hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors"
            title="Edit"
          >
            <Edit2 className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
            className="p-1 rounded-[3px] hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Drag handle - left edge */}
      <div
        {...attributes}
        {...listeners}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 hover:bg-slate-200 transition-opacity rounded-l-[6px]"
      />
    </div>
  );
}
