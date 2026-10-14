import { useCallback, useEffect, useState } from 'react';
import { useOnline } from './useOnline';
import { isServerDown, replayOfflineQueue } from '../store/kanban';
import { QUEUE_CHANGE_EVENT, queueCount } from '../store/offlineQueue';

/** Shared offline state: browser flag + server reachability + queued-write count. */
export function useOfflineSync() {
  const online = useOnline();
  const [serverDown, setServerDown] = useState(false);
  const [queued, setQueued] = useState(() => queueCount());
  const [replaying, setReplaying] = useState(false);

  const refreshSyncState = useCallback(() => {
    setServerDown(isServerDown());
    setQueued(queueCount());
  }, []);

  useEffect(() => {
    const onChange = () => setQueued(queueCount());
    window.addEventListener(QUEUE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(QUEUE_CHANGE_EVENT, onChange);
  }, []);

  const replayQueue = useCallback(async (): Promise<void> => {
    setReplaying(true);
    try {
      await replayOfflineQueue();
    } finally {
      refreshSyncState();
      setReplaying(false);
    }
  }, [refreshSyncState]);

  return {
    online,
    offline: !online || serverDown,
    serverDown,
    queued,
    replaying,
    refreshSyncState,
    replayQueue,
  };
}
