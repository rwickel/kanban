import { TaskStatus } from '../types';
import { Inbox, Loader, CheckCircle2, AlertOctagon } from 'lucide-react';

const ITEMS: { status: TaskStatus; label: string; Icon: typeof Inbox }[] = [
  { status: 'backlog', label: 'Backlog', Icon: Inbox },
  { status: 'running', label: 'Running', Icon: Loader },
  { status: 'done', label: 'Done', Icon: CheckCircle2 },
  { status: 'blocked', label: 'Blocked', Icon: AlertOctagon },
];

export default function ColumnTabs({
  counts,
  active,
  onChange,
}: {
  counts: Record<TaskStatus, number>;
  active: TaskStatus;
  onChange: (s: TaskStatus) => void;
}) {
  return (
    <div className="m-tabs" role="tablist" aria-label="Columns">
      {ITEMS.map(({ status, label, Icon }) => (
        <button
          key={status}
          role="tab"
          aria-selected={active === status}
          className={`m-tab ${active === status ? 'is-active' : ''}`}
          onClick={() => onChange(status)}
        >
          <Icon className="m-tab-icon" strokeWidth={1.75} />
          <span>{label}</span>
          <span className="pill p-neutral" style={{ fontSize: 10, padding: '1px 6px' }}>{counts[status] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
