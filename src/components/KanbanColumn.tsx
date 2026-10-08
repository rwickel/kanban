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
  backlog: 'from-gray-500 to-gray-600',
  running: 'from-blue-500 to-cyan-500',
  done: 'from-emerald-500 to-green-500',
  blocked: 'from-red-500 to-rose-500',
};

const statusBorderColors: Record<TaskStatus, string> = {
  backlog: 'border-gray-700/50',
  running: 'border-blue-500/30',
  done: 'border-emerald-500/30',
  blocked: 'border-red-500/30',
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
      className={`flex flex-col bg-gray-900/50 backdrop-blur-sm rounded-2xl border ${statusBorderColors[status]} min-w-[300px] w-[320px] max-h-[calc(100vh-200px)] transition-all duration-200 ${
        isOver ? 'ring-2 ring-violet-500/50 bg-gray-900/80' : ''
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between p-4 pb-2">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">{icon}</span>
          <h3 className="font-semibold text-gray-100 text-sm">{title}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full bg-gradient-to-r ${statusColors[status]} text-white font-medium`}>
            {tasks.length}
          </span>
        </div>
        <button
          onClick={onAddTask}
          className="p-1.5 rounded-lg hover:bg-gray-700/50 text-gray-400 hover:text-white transition-colors"
          title="Add task"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Tasks list */}
      <div
        ref={setNodeRef}
        className="flex-1 overflow-y-auto p-3 pt-1 space-y-0 min-h-[100px]"
      >
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-24 border-2 border-dashed border-gray-700/50 rounded-xl">
            <p className="text-xs text-gray-500">Drop tasks here</p>
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
