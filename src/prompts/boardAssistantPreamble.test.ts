import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTeamLines,
  hasPreamble,
  renderPreamble,
} from './boardAssistantPreamble.ts';
import type { Agent, Project } from '../types';

const project: Project = {
  id: 'proj-1',
  name: 'Demo',
  path: 'C:\\work\\demo',
  folder: 'demo',
  gitUrl: null,
  gitBranch: 'main',
  description: '',
  agentIds: ['coder', 'reviewer'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const agents: Agent[] = [
  { id: 'coder', name: 'Coder', description: 'Builds things', color: '#fff' },
  { id: 'reviewer', name: 'Reviewer', description: 'Reviews things', color: '#000' },
];

test('renders every known slot and leaves unknown slots visible', () => {
  const out = renderPreamble('# Board assistant — {{projectName}}\n{{teamLines}}\n{{nope}}', {
    projectName: project.name,
    projectDescription: project.description,
    projectPath: project.path,
    projectId: project.id,
    sessionId: 'ses_1',
    teamLines: '- Coder (id: coder)',
    styleGuide: 'Be brief.',
  });
  assert.match(out, /# Board assistant — Demo/);
  assert.match(out, /- Coder \(id: coder\)/);
  // Unknown slots must not silently become empty — keep the typo visible.
  assert.match(out, /\{\{nope\}\}/);
});

test('empty string values keep their placeholder rather than blanking the line', () => {
  const out = renderPreamble('Session id: {{sessionId}}', {
    projectName: 'Demo',
    projectDescription: '',
    projectPath: '',
    projectId: '',
    sessionId: '',
    teamLines: '',
    styleGuide: '',
  });
  assert.equal(out, 'Session id: {{sessionId}}');
});

test('team lines use the project roster with descriptions', () => {
  const lines = buildTeamLines(project, agents);
  assert.match(lines, /- Coder \(id: coder\) — Builds things/);
  assert.match(lines, /- Reviewer \(id: reviewer\) — Reviews things/);
});

test('team lines degrade to raw ids when the agent is not in the fetched list', () => {
  const lines = buildTeamLines({ ...project, agentIds: ['ghost'] }, agents);
  assert.equal(lines, '- (id: ghost)');
});

test('team lines say the board is unconfigured when there is no roster', () => {
  const lines = buildTeamLines({ ...project, agentIds: [] }, agents);
  assert.equal(lines, '(no project team configured — all agents available)');
});

test('hasPreamble recognizes the marker used to block stacked prefixes', () => {
  assert.equal(hasPreamble('# Board assistant — Demo\nhi'), true);
  assert.equal(hasPreamble('just a normal message'), false);
});
