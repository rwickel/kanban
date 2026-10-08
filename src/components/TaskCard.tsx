import { Task, TaskPriority } from '../types';
import { MessageSquare, Edit2, Trash2, GripVertical } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  onOpenChat: (task: Task) => void;
}

const priorityConfig: Record<TaskPriority, { color: string; label: string; bg: string }> = {
  low: { color: 'text-emerald-400', label: 'Low', bg: 'bg-emerald-400/10 border-emerald-400/30' },
  medium: { color: 'text-blue-400', label: 'Medium', bg: 'bg-blue-400/10 border-blue-400/30' },
  high: { color: 'text-amber-400', label: 'High', bg: 'bg-amber-400/10 border-amber-400/30' },
  critical: { color: 'text-red-400', label: 'Critical', bg: 'bg-red-400/10 border-red-400/30' },
};

export default function TaskCard({ task, onEdit, onDelete, onOpenChat }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
  });

  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
      }
    : undefined;

  const priority = priorityConfig[task.priority];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative bg-gray-800/80 backdrop-blur-sm border border-gray-700/50 rounded-xl p-4 mb-3 transition-all duration-200 hover:border-gray-600 hover:shadow-lg hover:shadow-black/20 ${
        isDragging ? 'opacity-50 scale-105 shadow-2xl z-50' : ''
      }`}
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
      >
        <GripVertical className="w-4 h-4 text-gray-500" />
      </div>

      {/* Priority badge */}
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${priority.bg} ${priority.color} font-medium`}>
          {priority.label}
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(task)}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            title="Edit task"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="p-1 rounded hover:bg-red-900/50 text-gray-400 hover:text-red-400 transition-colors"
            title="Delete task"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Title */}
      <h4 className="text-sm font-medium text-gray-100 mb-1.5 line-clamp-2">{task.title}</h4>

      {/* Description */}
      {task.description && (
        <p className="text-xs text-gray-400 mb-3 line-clamp-2">{task.description}</p>
      )}

      {/* Agent bubble */}
      <div className="flex items-center justify-between">
        {task.agentName ? (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">
                {task.agentName.charAt(0).toUpperCase()}
              </span>
            </div>
            <span className="text-xs text-gray-400">{task.agentName}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center">
              <span className="text-[10px] text-gray-500">?</span>
            </div>
            <span className="text-xs text-gray-500">Unassigned</span>
          </div>
        )}

        {/* Chat icon — always visible when a session exists; pulsing placeholder while wiring up */}
        {task.sessionId ? (
          <button
            onClick={() => onOpenChat(task)}
            className="p-1.5 rounded-lg bg-gray-700/50 hover:bg-violet-600/30 text-gray-400 hover:text-violet-300 transition-all"
            title="Open agent chat"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        ) : (
          task.agentId && (
            <button
              onClick={() => onOpenChat(task)}
              className="p-1.5 rounded-lg bg-gray-700/30 text-gray-600 hover:text-violet-300 transition-all animate-pulse"
              title="Start session & open chat"
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </button>
          )
        )}
      </div>
    </div>
  );
}
