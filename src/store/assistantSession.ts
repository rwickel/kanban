// Board assistant session store: one assistant session per project.
// Owned here so the app can create it at startup AND the chat window can
// reuse it — whoever calls first creates it, everyone else reuses the id.
// The id doubles as parentSessionId when the assistant delegates tasks.

import { createSession, fetchAgents, putSessionInstruction } from '../api/opencode';
import {
  PREAMBLE_KEY,
  buildAssistantPreamble,
} from '../prompts/boardAssistantPreamble';
import type { Project } from '../types';
import { readSpeechLang } from '../hooks/usePreferences';
import { getTaskModelPref } from './serverConfig';
import { isModelAllowed, normalizeAllowedModels } from './modelResolution';

const SESSION_PREFIX = 'kanban_assistant_session_';
const AGENT_PREFIX = 'kanban_assistant_agent_';
const MODEL_PREFIX = 'kanban_assistant_model_';

export function assistantSessionKey(projectId: string) {
  return `${SESSION_PREFIX}${projectId}`;
}

export function readAssistantSessionId(projectId: string): string | null {
  try { return localStorage.getItem(assistantSessionKey(projectId)); } catch { return null; }
}

export function clearAssistantSession(projectId: string): void {
  try { localStorage.removeItem(assistantSessionKey(projectId)); } catch {}
}

export function readAssistantAgentPref(projectId: string): string {
  try { return localStorage.getItem(`${AGENT_PREFIX}${projectId}`) || ''; } catch { return ''; }
}

// Model preference: per-project pick first, then the board-wide task model —
// both only if the project allows them; otherwise the project's pool decides.
export function readAssistantModelPref(projectId: string, project?: Pick<Project, 'allowedModels' | 'id'> | null): string {
  const pool = project && project.id === projectId ? project.allowedModels : null;
  try {
    const stored = localStorage.getItem(`${MODEL_PREFIX}${projectId}`);
    if (stored && isModelAllowed(stored, pool)) return stored;
    const pref = getTaskModelPref();
    const board = pref ? `${pref.providerID}/${pref.modelID}` : '';
    if (isModelAllowed(board, pool)) return board;
    return normalizeAllowedModels(pool)[0] ?? '';
  } catch { return ''; }
}

export function saveAssistantPrefs(projectId: string, agentId: string, model: string): void {
  try {
    if (agentId) localStorage.setItem(`${AGENT_PREFIX}${projectId}`, agentId);
    else localStorage.removeItem(`${AGENT_PREFIX}${projectId}`);
    if (model) localStorage.setItem(`${MODEL_PREFIX}${projectId}`, model);
    else localStorage.removeItem(`${MODEL_PREFIX}${projectId}`);
  } catch {}
}

export interface EnsureResult {
  id: string | null;
  error?: string;
}

// In-flight creations per project: the app-startup effect and the open chat
// window may race — both callers get the same promise, one session is created.
const inflight = new Map<string, Promise<EnsureResult>>();

async function createFor(project: Project, agentId: string, model: string): Promise<EnsureResult> {
  const directory = project.path?.trim() || undefined;
  const agent = agentId || undefined;
  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/');
  const parsedModel = providerID && modelID ? { providerID, id: modelID } : undefined;
  const res = await createSession({ title: `Board assistant — ${project.name}`, agent, model: parsedModel, directory });
  if (!res.session?.id) {
    return { id: null, error: res.error ?? 'Failed to create assistant session.' };
  }
  try { localStorage.setItem(assistantSessionKey(project.id), res.session.id); } catch {}
  // Fast-path instruction push: tell the session its role right away. Only here
  // in createFor (behind the inflight map) — never in ensureAssistantSession or
  // the chat component, both of which also funnel into this call. Fire-and-forget:
  // a slow socket must not stall the chat opening (chat attach re-pushes anyway).
  void (async () => {
    try {
      const agents = await fetchAgents(directory);
      const language = readSpeechLang();
      const languageNames: Record<string, string> = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch' };
      const markdown = await buildAssistantPreamble(project, agents, res.session!.id, languageNames[language] ?? language);
      await putSessionInstruction(res.session!.id, PREAMBLE_KEY, markdown);
    } catch {
      /* S4 covers the miss: attach + one retry, then the inline fallback. */
    }
  })();
  return { id: res.session.id };
}

/**
 * Return the stored assistant session id for a project, creating one now if
 * none exists. Safe to call from both App startup and the chat window.
 */
export function ensureAssistantSession(
  project: Project,
  opts?: { agentId?: string; model?: string }
): Promise<EnsureResult> {
  const stored = readAssistantSessionId(project.id);
  if (stored) return Promise.resolve({ id: stored });
  const pending = inflight.get(project.id);
  if (pending) return pending;
  const agentId = opts?.agentId ?? readAssistantAgentPref(project.id);
  const model = opts?.model ?? readAssistantModelPref(project.id, project);
  const p = createFor(project, agentId, model).finally(() => inflight.delete(project.id));
  inflight.set(project.id, p);
  return p;
}
