import { TaskStatus } from '../types';
import { Inbox, Loader, CheckCircle2, AlertOctagon, Archive } from 'lucide-react';

const ITEMS: { status: TaskStatus; label: string; short: string; Icon: typeof Inbox }[] = [
  { status: 'backlog', label: 'Backlog', short: 'Back', Icon: Inbox },
  { status: 'running', label: 'Running', short: 'Run', Icon: Loader },
  { status: 'done', label: 'Done', short: 'Done', Icon: CheckCircle2 },
  { status: 'blocked', label: 'Blocked', short: 'Block', Icon: AlertOctagon },
  { status: 'archived', label: 'Archived', short: 'Arch', Icon: Archive },
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
    <nav className="m-tabs" role="tablist" aria-label="Columns" aria-orientation="vertical">
      {ITEMS.map(({ status, label, short, Icon }) => (
        <button
          key={status}
          role="tab"
          aria-selected={active === status}
          title={label}
          className={`m-tab ${active === status ? 'is-active' : ''}`}
          onClick={() => onChange(status)}
        >
          <Icon className="m-tab-icon" strokeWidth={1.75} aria-hidden />
          <span className="m-tab-label">{short}</span>
          <span className="m-tab-count">{counts[status] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}
