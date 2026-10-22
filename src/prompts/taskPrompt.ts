// Task prompt layers.
//
// Layer 1 — agent instructions. Loaded by OpenCode from the agent definition
//           (build, coder, testing, …). Never repeated in any board prompt.
// Layer 2 — task-session instruction. The static contract: lifecycle, work
//           method, delegation, security, communication, and (for cyclical
//           tasks) the checkpoint protocol. Installed ONCE via
//           PUT /experimental/session/{id}/instructions/entries/task-agent
//           when the session is created.
// Layer 3 — execution prompt. Short, sent once per run. Carries only what
//           actually changes between runs: title, description, priority,
//           and the cycle/checkpoint metadata for cyclical tasks.
//
// Why this split: previously every run — and therefore every cyclical run —
// both overwrote the instruction entry with the full prompt AND sent the same
// full text as the user message. The model saw the whole contract several
// times per cycle (verified on session ses_eb564e186ffeU3w8E4V9SZ0FP9).

import type { Agent, Project, Task } from '../types';

/** Durable instruction-entry key used for the task contract. */
export const TASK_INSTRUCTION_KEY = 'task-agent';

/** Directory (inside the project worktree) where cyclical tasks keep their
 *  own checkpoint file. One file per task id, owned by the agent. */
export const CHECKPOINT_DIR = '.kanban/checkpoints';

export function checkpointRelPath(taskId: string): string {
  return `${CHECKPOINT_DIR}/${taskId}.json`;
}

const FALLBACK_PREAMBLE =
  '# Task agent instructions\n\nExecute this task autonomously from start to finish.';

const FALLBACK_STYLE =
  '- Use Simplified Technical English (ASD-STE100) in your final message: approved simple verbs (add, remove, update, move, rename, fix, replace), one instruction per sentence, maximum 20 words per sentence, no jargon.';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
};

/** Preference code → human name used in prompts. Unknown codes pass through. */
export function resolveLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? (code || 'English');
}

// ---------------------------------------------------------------------------
// Prompt files. Read once per page load, cached like the board assistant
// preamble files. `preloadTaskPromptFiles()` warms both at app start so the
// first task never waits on the fetch.
// ---------------------------------------------------------------------------

let styleCache: string | null = null;
let preambleCache: string | null = null;

async function loadText(url: string): Promise<string> {
  try {
    const r = await fetch(url);
    return r.ok ? (await r.text()).trim() : '';
  } catch {
    return '';
  }
}

export async function loadStyleGuide(): Promise<string> {
  if (styleCache === null) styleCache = await loadText('/api/kanban/prompts/final-message-style.md');
  return styleCache;
}

export async function loadTaskPreamble(): Promise<string> {
  if (preambleCache === null) {
    const text = await loadText('/api/kanban/prompts/task-agent-preamble.md');
    // Resolve the placeholder to the actual HTTP/HTTPS origin used by Vite.
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';
    preambleCache = text.split('{{serverUrl}}').join(origin);
  }
  const cached = preambleCache;
  return cached ?? '';
}

export function preloadTaskPromptFiles(): void {
  void loadStyleGuide();
  void loadTaskPreamble();
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface TaskPromptContext {
  task: Task;
  project?: Project | null;
  agents: Agent[];
  /** Session this prompt is aimed at. Supplies the parentSessionId hint. */
  sessionId: string;
  /** Human response language, e.g. "German". Defaults to English. */
  language?: string;
  /** Board origin used in API hints. Defaults to the page origin. */
  serverUrl?: string;
  /** True when this session was created just now (first run of the session). */
  firstRun?: boolean;
  /** ISO timestamp of this run. Required for cyclical tasks. */
  runTime?: string;
  /** Overrides, mainly for tests. Default to the module caches. */
  preamble?: string;
  style?: string;
}

function boardOrigin(ctx: TaskPromptContext): string {
  return (
    ctx.serverUrl?.replace(/\/+$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001')
  );
}

function assignedAgent(task: Task, agents: Agent[]): { id: string; name: string } | undefined {
  if (!task.agentId) return undefined;
  const found = agents.find((a) => a.id === task.agentId);
  return { id: task.agentId, name: task.agentName ?? found?.name ?? task.agentId };
}

/** Roster lines, same format the board assistant preamble uses. */
export function buildTeamLines(project: Project | null | undefined, agents: Agent[]): string {
  const teamIds = project?.agentIds ?? [];
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

function projectLine(task: Task, project: Project | null | undefined): string {
  const name = project?.name?.trim();
  const path = project?.path?.trim();
  return name ? `${name}${path ? ` (${path})` : ''}` : '(unknown)';
}

function parentSessionLine(task: Task, sessionId: string): string {
  if (task.parentSessionId) {
    return `${task.parentSessionId} (the session that created this task — report back there if needed; never use it as the parent of a task you create)`;
  }
  void sessionId;
  return '— (created directly by user/board)';
}

// ---------------------------------------------------------------------------
// Layer 2 — session instruction. Installed once per session.
// ---------------------------------------------------------------------------

export function buildTaskSessionInstruction(ctx: TaskPromptContext): string {
  const { task, project, agents, sessionId } = ctx;
  const preamble = (ctx.preamble ?? preambleCache ?? '').trim() || FALLBACK_PREAMBLE;
  const style = (ctx.style ?? styleCache ?? '').trim() || FALLBACK_STYLE;
  const language = ctx.language?.trim() || 'English';
  const origin = boardOrigin(ctx);
  const title = task.title?.trim() || 'Untitled task';
  const assigned = assignedAgent(task, agents);
  const cyclic = task.kind === 'cyclic';
  const criteria = task.acceptanceCriteria?.trim() || '';

  return [
    preamble,
    '',
    `# Task session — ${title}`,
    '',
    'This session runs exactly one board task. The contract below is installed once and is not repeated in later run messages.',
    '',
    `**Task id:** ${task.id}`,
    `**Project:** ${projectLine(task, project)}`,
    `**Project id:** ${task.projectId}`,
    `**Your session id:** ${sessionId}`,
    `**Parent session:** ${parentSessionLine(task, sessionId)}`,
    assigned ? `**Assigned agent:** ${assigned.name} (id: ${assigned.id})` : undefined,
    task.worktreePath ? `**Worktree folder:** ${task.worktreePath}` : undefined,
    task.worktreeBranch ? `**Worktree branch:** ${task.worktreeBranch}` : undefined,
    ...(criteria ? ['', '**Acceptance criteria:**', criteria] : []),
    '',
    '**Team for this project:**',
    buildTeamLines(project, agents),
    '',
    '## How to work',
    '',
    '- Execute autonomously end-to-end: read the project, plan if needed, make the changes, leave it in a working state.',
    '- Work only on this task. Do not create duplicate or replacement tasks.',
    '- The board links every task you create to your own session. Never pass a parent session id yourself: the parent is always the session you run in.',
    '- Ask the user only if blocked; keep the final message concise — it becomes the stored task result automatically.',
    '- A successful session alone does not prove completion. Verify every acceptance criterion and required check before reporting.',
    '- Your final message is the task result. Keep it short and concrete: what changed, the branch, the changed files, the commands and their output.',
    '- If a criterion or a check is not met, do not report completion. Call kanban_update_status with your task id and blocked, and explain what remains.',
    '- Do not change task status manually. The board uses these explicit markers to decide whether work is done or blocked.',
    '- Do not write the task result into the task description.',
    ...(task.worktreePath ? [
      '',
      '## Worktree isolation',
      '',
      `- This task runs in its own git worktree: ${task.worktreePath}`,
      `- Branch: ${task.worktreeBranch ?? 'the task branch'}`,
      '- Change only files inside the worktree. Do not edit the main project folder.',
      '- Do not merge, do not push, and do not switch branches. The board merges the branch.',
      '- Commit the finished work on the branch (git add -A, then git commit). Uncommitted work is not merged.',
      '- Run tests and builds inside the worktree.',
    ] : []),
    '',
    '## Communication',
    '',
    style,
    `- Write all chat output, task results, and summaries in ${language}.`,
    '- Use Simplified Technical English (ASD-STE100) principles: short sentences, simple verbs, direct statements, and specific results.',
    '- Keep technical names, file paths, API paths, IDs, and code unchanged.',
    '',
    '## Working with other tasks (optional)',
    '',
    `- API base: ${origin}/api (full spec: ${origin}/api/kanban/docs).`,
    `- Follow-up work: POST /api/kanban/tasks { "projectId": "${task.projectId}", "title": "...", "description": "...", "priority": "medium", "parentSessionId": "${sessionId}" }.`,
    `- Delegate + WAIT for result (sync): POST /api/kanban/delegate { "projectId": "${task.projectId}", "title": "...", "description": "...", "agentId": "<teammate-id>", "parentSessionId": "${sessionId}" } → returns the finished Task.`,
    '- Follow-up in the SAME subtask session: POST /api/kanban/message_to { "sessionId": "<from delegate>", "text": "..." } (or { "taskId": "<subtask-id>", "text": "..." }) → { sessionId, resultText }.',
    `- List work: GET /api/kanban/tasks?projectId=${task.projectId}.`,
    '',
    '## Project instructions and lessons',
    '',
    '- Read the project-local AGENTS.md before planning when it exists.',
    '- Add durable project instructions, decisions, conventions, commands, and lessons to AGENTS.md.',
    '- Create AGENTS.md in the project root when the user asks to save durable guidance.',
    '- Update existing entries instead of adding duplicates.',
    '- Keep temporary task notes in the task description or result.',
    '- Never store passwords, tokens, private keys, or other secrets in AGENTS.md.',
    '- Report AGENTS.md changes in the final task result.',
    ...(cyclic ? [
      '',
      '## Cyclical checkpoint protocol',
      '',
      `This task is cyclical. Your checkpoint file is \`${checkpointRelPath(task.id)}\` inside the project worktree.`,
      '- At the START of every cycle, read the checkpoint file.',
      '- The checkpoint file is authoritative. Ignore what earlier cycles claimed in chat.',
      '- If the file does not exist, create it and treat the previous position as "no checkpoint" — then process the last 24 hours, or everything new you can identify.',
      '- Process only items that are new or changed AFTER the stored checkpoint.',
      '- Write the checkpoint file only AFTER a cycle completed successfully.',
      '- If a cycle fails or is interrupted, leave the checkpoint file unchanged so the next cycle retries those items.',
      '- Store cursors, ids, timestamps, and counters only. Never store secrets, message bodies, or other private content.',
      '- Never delete the checkpoint file.',
      '- The final message of every cycle must state the cycle time, what was processed, what was skipped as duplicate, and any error.',
    ] : []),
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Layer 3 — execution prompt. Sent once per run.
// ---------------------------------------------------------------------------

export function buildTaskRunPrompt(ctx: TaskPromptContext): string {
  const { task, sessionId } = ctx;
  const title = task.title?.trim() || 'Untitled task';
  const desc = task.description?.trim() || '(no description provided)';
  const criteria = task.acceptanceCriteria?.trim() || '';
  const prio = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium';
  const origin = boardOrigin(ctx);
  const cyclic = task.kind === 'cyclic';
  const runTime = ctx.runTime || new Date().toISOString();

  const head = cyclic
    ? [
        ctx.firstRun ? 'Run the first cycle of this cyclical task.' : 'Run the next cycle of this cyclical task.',
        '',
        `Task id: ${task.id}`,
        `Session id: ${sessionId}`,
        `Cycle time: ${runTime}`,
        Number(task.cycleIntervalSec) > 0
          ? `Repeats: every ${Math.round(Number(task.cycleIntervalSec))} seconds`
          : undefined,
        `Checkpoint file: ${checkpointRelPath(task.id)}`,
        `Title: ${title}`,
        `Priority: ${prio}`,
      ]
    : [
        'Execute this task now.',
        '',
        `Task id: ${task.id}`,
        `Session id: ${sessionId}`,
        `Title: ${title}`,
        `Priority: ${prio}`,
      ];

  return [
    ...head.filter(Boolean),
    '',
    '## What to do',
    '',
    desc,
    ...(criteria ? ['', '## Acceptance criteria', '', criteria] : []),
    '',
    cyclic
      ? 'Follow the checkpoint protocol from your session instructions: read the checkpoint file before working, update it only after a successful cycle.'
      : `The full task contract is in your session instructions (entry "${TASK_INSTRUCTION_KEY}"). Follow it.`,
    `Board API base: ${origin}/api.`,
  ].join('\n');
}

/** Full contract + run prompt. Only used when the instruction entry could not
 *  be installed, so a failed PUT never leaves the agent without rules. */
export function buildTaskFallbackPrompt(ctx: TaskPromptContext): string {
  return `${buildTaskSessionInstruction(ctx)}\n\n${buildTaskRunPrompt(ctx)}`;
}
