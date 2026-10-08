import { Task, TaskStatus } from '../types';
import TaskCard from './TaskCard';
import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';

interface KanbanColumnProps {
  status: TaskStatus;
  title: string;
  icon: string;
  tasks: Task[];
  onEditTask: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onOpenChat: (task: Task) => void;
  onAddTask: () => void;
  onStartTask?: (task: Task) => void;
}

const statusColors: Record<TaskStatus, string> = {
  backlog: 'bg-slate-400',
  running: 'bg-blue-500',
  done: 'bg-emerald-500',
  blocked: 'bg-red-500',
};

export default function KanbanColumn({
  status,
  title,
  icon,
  tasks,
  onEditTask,
  onDeleteTask,
  onOpenChat,
  onAddTask,
  onStartTask,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    data: { status },
  });

  return (
    <div
      className={`flex flex-col bg-slate-50/50 rounded-[6px] border min-w-[280px] w-[300px] max-h-[calc(100vh-180px)] transition-all duration-150 ${
        isOver ? 'border-slate-400 bg-slate-100/80' : 'border-slate-200'
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColors[status]}`} />
          <h3 className="text-[13px] font-semibold text-slate-900">{title}</h3>
          <span className="text-[11px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-[3px]">
            {tasks.length}
          </span>
        </div>
        <button
          onClick={onAddTask}
          className="p-1 rounded-[3px] hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors"
          title="Add task (N)"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tasks list */}
      <div
        ref={setNodeRef}
        className="flex-1 overflow-y-auto p-2 min-h-[100px]"
      >
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-20 border border-dashed border-slate-200 rounded-[4px]">
            <p className="text-[11px] text-slate-400">Drop tasks here</p>
          </div>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onEdit={onEditTask}
            onDelete={onDeleteTask}
            onOpenChat={onOpenChat}
            onStartTask={onStartTask}
          />
        ))}
      </div>
    </div>
  );
}
