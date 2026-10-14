import { CloudOff, RefreshCw } from 'lucide-react';

export default function OfflineBanner({ offline, queued, retrying, onRetry }: {
  offline: boolean;
  queued: number;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (!offline && queued === 0) return null;
  return (
    <div
      role="alert"
      className="mx-4 mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-[13px]"
      style={{
        background: 'color-mix(in srgb, var(--amber) 12%, transparent)',
        border: '1px solid var(--amber)',
        color: 'var(--text)',
      }}
    >
      <CloudOff className="w-4 h-4 shrink-0" style={{ color: 'var(--amber)' }} />
      <span className="flex-1">
        {offline
          ? `Offline — showing saved data.${queued > 0 ? ` ${queued} change${queued === 1 ? '' : 's'} queued, syncs on reconnect.` : ''}`
          : `${queued} change${queued === 1 ? '' : 's'} waiting to sync.`}
      </span>
      {queued > 0 && (
        <button
          onClick={onRetry}
          disabled={retrying}
          className="btn flex items-center gap-1 px-2 py-1 text-[12px] font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  );
}
