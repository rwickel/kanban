import { Task, TaskStatus } from '../types';
import TaskCard from './TaskCard';
import { useDroppable } from '@dnd-kit/core';
import { Plus, Inbox, Loader, CheckCircle2, AlertOctagon, LucideIcon } from 'lucide-react';

interface KanbanColumnProps {
  status: TaskStatus;
  title: string;
  icon: LucideIcon;
  tasks: Task[];
  onEditTask: (task: Task) => void;
  onDeleteTask: (id: string) => void;
  onOpenChat: (task: Task) => void;
  onAddTask: () => void;
}

const statusDot: Record<TaskStatus, string> = {
  backlog: 'var(--muted)',
  running: 'var(--amber)',
  done: 'var(--emerald)',
  blocked: 'var(--danger)',
};

export const columnIcons: Record<TaskStatus, LucideIcon> = {
  backlog: Inbox,
  running: Loader,
  done: CheckCircle2,
  blocked: AlertOctagon,
};

export default function KanbanColumn({
  status,
  title,
  icon: Icon,
  tasks,
  onEditTask,
  onDeleteTask,
  onOpenChat,
  onAddTask,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    data: { status },
  });

  return (
    <div
      className="column-shell flex flex-col min-w-[320px] w-[340px] max-h-[calc(100vh-170px)]"
      style={isOver ? { borderColor: 'var(--border-strong)' } : undefined}
    >
      <div className="flex items-center justify-between px-3.5 py-3 border-b hairline" style={{ borderBottomStyle: 'solid', borderBottomWidth: 1 }}>
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 muted" strokeWidth={1.75} />
          <span className="dot" style={{ background: statusDot[status], width: 6, height: 6 }} />
          <h3 className="font-semibold t-strong text-[13px] uppercase tracking-wide">{title}</h3>
          <span className="pill p-neutral">{tasks.length}</span>
        </div>
        <button onClick={onAddTask} className="btn p-1.5" title="Add task (N)">
          <Plus className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-3 min-h-[120px]">
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-20 border border-dashed hairline" style={{ borderRadius: 6 }}>
            <p className="text-[13px] muted mono">Drop here</p>
          </div>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onEdit={onEditTask}
            onDelete={onDeleteTask}
            onOpenChat={onOpenChat}
          />
        ))}
      </div>
    </div>
  );
}
