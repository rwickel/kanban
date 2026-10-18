import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKPOINT_DIR,
  TASK_INSTRUCTION_KEY,
  buildTaskFallbackPrompt,
  buildTaskRunPrompt,
  buildTaskSessionInstruction,
  buildTeamLines,
  checkpointRelPath,
  resolveLanguageName,
} from './taskPrompt.ts';
import type { TaskPromptContext } from './taskPrompt.ts';
import type { Agent, Project, Task } from '../types';

const project: Project = {
  id: 'proj-1',
  name: 'Kanban',
  path: 'C:\\work\\kanban',
  folder: 'kanban',
  gitUrl: null,
  gitBranch: 'main',
  description: 'Board',
  agentIds: ['coder'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const agents: Agent[] = [
  { id: 'coder', name: 'Coder', description: 'Builds things', color: '#fff' },
];

const baseTask: Task = {
  id: 'task-1',
  title: 'Check email',
  description: 'Summarize unread important messages.',
  status: 'running',
  priority: 'high',
  agentId: 'coder',
  agentName: 'Coder',
  projectId: 'proj-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function ctx(overrides: Partial<TaskPromptContext> = {}): TaskPromptContext {
  return {
    task: baseTask,
    project,
    agents,
    sessionId: 'ses_1',
    language: 'German',
    serverUrl: 'https://board.local',
    preamble: 'PREAMBLE',
    style: 'STYLE',
    ...overrides,
  };
}

// --- layer 2: session instruction -------------------------------------------

test('session instruction carries the durable contract and the session ids', () => {
  const out = buildTaskSessionInstruction(ctx());
  assert.match(out, /PREAMBLE/);
  assert.match(out, /STYLE/);
  assert.match(out, /\*\*Task id:\*\* task-1/);
  assert.match(out, /\*\*Project id:\*\* proj-1/);
  assert.match(out, /\*\*Your session id:\*\* ses_1/);
  assert.match(out, /- Coder \(id: coder\) — Builds things/);
  assert.match(out, /Write all chat output, task results, and summaries in German/);
});

test('session instruction does NOT carry the per-run description', () => {
  // The description belongs to the execution prompt. Keeping it out means an
  // edited description is picked up by the next run without rewriting the
  // durable entry.
  const out = buildTaskSessionInstruction(ctx());
  assert.doesNotMatch(out, /Summarize unread important messages/);
  assert.doesNotMatch(out, /\*\*Priority:\*\*/);
});

test('session instruction keeps the parent session hint for delegated tasks', () => {
  const out = buildTaskSessionInstruction(ctx({ task: { ...baseTask, parentSessionId: 'ses_parent' } }));
  assert.match(out, /\*\*Parent session:\*\* ses_parent/);
  const direct = buildTaskSessionInstruction(ctx());
  assert.match(direct, /created directly by user\/board/);
});

test('oneshot session instruction has no checkpoint protocol', () => {
  const out = buildTaskSessionInstruction(ctx());
  assert.doesNotMatch(out, /checkpoint/i);
});

test('cyclical session instruction adds the checkpoint protocol with the file path', () => {
  const task: Task = { ...baseTask, kind: 'cyclic', cycleIntervalSec: 3600 };
  const out = buildTaskSessionInstruction(ctx({ task }));
  assert.match(out, /## Cyclical checkpoint protocol/);
  assert.match(out, new RegExp(`\\.kanban/checkpoints/task-1\\.json`));
  assert.match(out, /checkpoint file is authoritative/i);
  assert.match(out, /only AFTER a cycle completed successfully/);
  assert.match(out, /leave the checkpoint file unchanged/);
  assert.match(out, /Never store secrets/);
});

// --- layer 3: execution prompt ----------------------------------------------

test('oneshot execution prompt is short and carries the run-specific data', () => {
  const out = buildTaskRunPrompt(ctx());
  assert.match(out, /Execute this task now\./);
  assert.match(out, /Task id: task-1/);
  assert.match(out, /Session id: ses_1/);
  assert.match(out, /Title: Check email/);
  assert.match(out, /Priority: High/);
  assert.match(out, /Summarize unread important messages\./);
  // The contract lives in the instruction entry, not in every run message.
  assert.doesNotMatch(out, /PREAMBLE/);
  assert.doesNotMatch(out, /STYLE/);
  assert.doesNotMatch(out, /Delegation and follow-up/);
  assert.doesNotMatch(out, /checkpoint/i);
});

test('cyclical execution prompt announces first vs next cycle plus cycle metadata', () => {
  const task: Task = { ...baseTask, kind: 'cyclic', cycleIntervalSec: 3600 };
  const first = buildTaskRunPrompt(ctx({ task, firstRun: true, runTime: '2026-10-17T09:00:00.000Z' }));
  assert.match(first, /Run the first cycle/);
  assert.match(first, /Cycle time: 2026-10-17T09:00:00\.000Z/);
  assert.match(first, /Repeats: every 3600 seconds/);
  assert.match(first, /Checkpoint file: \.kanban\/checkpoints\/task-1\.json/);
  assert.match(first, /Follow the checkpoint protocol/);

  const next = buildTaskRunPrompt(ctx({ task, firstRun: false, runTime: '2026-10-17T10:00:00.000Z' }));
  assert.match(next, /Run the next cycle/);
  assert.doesNotMatch(next, /Run the first cycle/);
});

test('cyclical execution prompt omits the interval when it is not configured', () => {
  const task: Task = { ...baseTask, kind: 'cyclic', cycleIntervalSec: null };
  const out = buildTaskRunPrompt(ctx({ task }));
  assert.doesNotMatch(out, /Repeats:/);
});

test('execution prompt falls back to safe placeholders for empty task fields', () => {
  const task: Task = { ...baseTask, title: '', description: '', priority: 'medium' };
  const out = buildTaskRunPrompt(ctx({ task }));
  assert.match(out, /Title: Untitled task/);
  assert.match(out, /\(no description provided\)/);
});

// --- fallback + helpers -----------------------------------------------------

test('fallback prompt is instruction + run prompt, so a failed PUT still works', () => {
  const out = buildTaskFallbackPrompt(ctx());
  assert.equal(out, `${buildTaskSessionInstruction(ctx())}\n\n${buildTaskRunPrompt(ctx())}`);
  assert.match(out, /PREAMBLE/);
  assert.match(out, /Execute this task now\./);
});

test('checkpoint path is one file per task under .kanban/checkpoints', () => {
  assert.equal(checkpointRelPath('abc'), `${CHECKPOINT_DIR}/abc.json`);
});

test('instruction key stays task-agent for compatibility with existing sessions', () => {
  assert.equal(TASK_INSTRUCTION_KEY, 'task-agent');
});

test('language codes resolve to human names and unknown codes pass through', () => {
  assert.equal(resolveLanguageName('de'), 'German');
  assert.equal(resolveLanguageName('xx'), 'xx');
  assert.equal(resolveLanguageName(''), 'English');
});

test('team lines degrade the same way as the board assistant preamble', () => {
  assert.equal(buildTeamLines({ ...project, agentIds: ['ghost'] }, agents), '- (id: ghost)');
  assert.equal(buildTeamLines({ ...project, agentIds: [] }, agents), '(no project team configured — all agents available)');
});
