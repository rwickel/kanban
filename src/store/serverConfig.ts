// Task model preference stored per task and used as the default for new tasks.
const TASK_MODEL_KEY = 'kanban_task_model';

export interface TaskModelPref {
  providerID: string;
  modelID: string;
}

export function getTaskModelPref(): TaskModelPref | null {
  try {
    const raw = localStorage.getItem(TASK_MODEL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value?.providerID === 'string' && typeof value?.modelID === 'string') return value as TaskModelPref;
    return null;
  } catch {
    return null;
  }
}

export function saveTaskModelPref(pref: TaskModelPref | null): void {
  if (!pref) localStorage.removeItem(TASK_MODEL_KEY);
  else localStorage.setItem(TASK_MODEL_KEY, JSON.stringify(pref));
}

export function formatModelId(pref: TaskModelPref | null): string {
  return pref ? `${pref.providerID}/${pref.modelID}` : '— default —';
}
