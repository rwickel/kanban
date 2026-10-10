const SERVER_URL_KEY = 'kanban_server_url';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4099';

export interface ServerConfig {
  url: string;
}

export function getServerConfig(): ServerConfig {
  return { url: localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL };
}

export function saveServerConfig(config: Partial<ServerConfig>): void {
  if (config.url !== undefined) localStorage.setItem(SERVER_URL_KEY, config.url);
}

// One-time migration: drop any password left from the old localStorage scheme.
try { localStorage.removeItem('kanban_server_password'); } catch {}

// Task model preference stored per-task, and default for new tasks.
const TASK_MODEL_KEY = 'kanban_task_model';
export interface TaskModelPref {
  providerID: string;
  modelID: string;
}
export function getTaskModelPref(): TaskModelPref | null {
  try {
    const raw = localStorage.getItem(TASK_MODEL_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o?.providerID === 'string' && typeof o?.modelID === 'string') return o as TaskModelPref;
    return null;
  } catch { return null; }
}
export function saveTaskModelPref(pref: TaskModelPref | null): void {
  if (!pref) localStorage.removeItem(TASK_MODEL_KEY);
  else localStorage.setItem(TASK_MODEL_KEY, JSON.stringify(pref));
}
export function formatModelId(pref: TaskModelPref | null): string {
  return pref ? `${pref.providerID}/${pref.modelID}` : '— default —';
}
