// Board assistant preamble — the single source of truth for what the
// assistant is told about itself. Two consumers render from here so the
// text can never drift between them:
//
//   1. Instruction tier (primary): PUT /api/experimental/session/{id}/instructions/entries/board-assistant
//      body { value: <rendered> }. Durable, announced at the next step boundary.
//   2. Inline fallback: prepended to the POST /session/{id}/prompt text when the
//      instruction PUT is unavailable (see AssistantChatWindow.handleSend).
//
// The role/delegate/style rules live in prompts/board-assistant-preamble.md.
// Editing that file changes both paths; edit it, then reload the chat window.

import type { Agent, Project } from '../types';

/** Instruction-entry key used on the session. */
export const PREAMBLE_KEY = 'board-assistant';

/**
 * First line of the template. Used as the "already prefixed?" guard on the
 * inline fallback so repeated sends never stack copies of the preamble.
 */
export const PREAMBLE_MARKER = '# Board assistant —';

export const PREAMBLE_FILE = '/api/kanban/prompts/board-assistant-preamble.md';
export const STYLE_FILE = '/api/kanban/prompts/final-message-style.md';

// Minimal text used when prompts/board-assistant-preamble.md is unreadable.
// Keeps the marker (so the fallback guard works) plus the one fact the
// assistant cannot work without: its own session id.
const FALLBACK_TEMPLATE = [
  `# Board assistant — {{projectName}}`,
  '',
  'This chat is the board assistant for {{projectName}}. It is not a board task.',
  '',
  'Project description: {{projectDescription}}',
  '',
  'Session id: {{sessionId}}',
  'Pass `"parentSessionId": "{{sessionId}}"` when you delegate work so results link back here.',
  '',
   'Board server: {{serverUrl}}/',
   'Board API: {{serverUrl}}/api (spec: {{serverUrl}}/api/kanban/docs)',
  '',
  '## Team for this project',
  '',
  '{{teamLines}}',
  '',
  '{{styleGuide}}',
].join('\n');

export interface PreambleVars {
  projectName: string;
  projectDescription: string;
  configuredLanguage: string;
  projectPath: string;
  projectId: string;
  sessionId: string;
  teamLines: string;
  styleGuide: string;
  serverUrl: string;
}

/** Roster lines in the same format the task prompt uses (App.tsx buildTaskPrompt). */
export function buildTeamLines(project: Project, agents: Agent[]): string {
  const teamIds = project.agentIds ?? [];
  const teamAgents = teamIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => Boolean(a));
  if (teamAgents.length > 0) {
    return teamAgents
      .map((a) => `- ${a.name} (id: ${a.id})${a.description ? ` — ${a.description}` : ''}`)
      .join('\n');
  }
  if (teamIds.length > 0) return teamIds.map((id) => `- (id: ${id})`).join('\n');
  return '(no project team configured — all agents available)';
}

/** Substitute {{var}} slots. Unknown slots are left untouched so a typo is visible. */
export function renderPreamble(template: string, vars: PreambleVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = (vars as unknown as Record<string, string | undefined>)[key];
    return typeof value === 'string' && value.length > 0 ? value : match;
  });
}

// Both prompt files are read once per page load, same caching style as the
// task style guide (App.tsx loadStyleGuide).
let templateCache: string | null = null;
let styleCache: string | null = null;

async function loadText(url: string): Promise<string> {
  try {
    const r = await fetch(url);
    return r.ok ? (await r.text()).trim() : '';
  } catch {
    return '';
  }
}

export async function loadStyleGuide(): Promise<string> {
  if (styleCache === null) styleCache = await loadText(STYLE_FILE);
  return styleCache;
}

export async function loadPreambleTemplate(): Promise<string> {
  if (templateCache === null) {
    const text = await loadText(PREAMBLE_FILE);
    // A missing or malformed file must not silently produce an empty
    // instruction: fall back to the built-in minimum instead.
    templateCache = text.includes(PREAMBLE_MARKER) ? text : FALLBACK_TEMPLATE;
  }
  return templateCache;
}

/** Build the full preamble markdown for one session. */
export async function buildAssistantPreamble(
  project: Project,
  agents: Agent[],
  sessionId: string,
  configuredLanguage = 'English'
): Promise<string> {
  const [template, styleGuide] = await Promise.all([loadPreambleTemplate(), loadStyleGuide()]);
  return renderPreamble(template, {
    projectName: project.name?.trim() || '(unnamed project)',
    projectDescription: project.description?.trim() || '(no project description provided)',
    configuredLanguage,
    projectPath: project.path?.trim() || '(no path)',
    projectId: project.id,
    sessionId,
    teamLines: buildTeamLines(project, agents),
    styleGuide: styleGuide || 'Use short, clear sentences. State what changed in the code.',
    serverUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001',
  });
}

/** True when text already carries the preamble (fallback stacking guard). */
export function hasPreamble(text: string): boolean {
  return text.includes(PREAMBLE_MARKER);
}
