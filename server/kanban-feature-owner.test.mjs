// Integration tests for the feature inheritance of delegated tasks and for
// the "goal" task kind.
//
// A feature orchestrator creates the feature and then delegates the steps.
// The steps must work in the feature worktree, so the server gives them the
// feature of the calling session.
//
// Run via `npm test` (package.json test glob covers server/**/*.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'kanban.py');
const PYTHON = process.env.KANBAN_PYTHON || 'python';

const work = mkdtempSync(join(tmpdir(), 'kanban-owner-'));
const DB = join(work, 'kanban.db');
const ROOT = join(work, 'projects');
mkdirSync(ROOT, { recursive: true });

function run(args) {
  const r = spawnSync(PYTHON, [CLI, '--db', DB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KANBAN_PROJECTS_ROOT: ROOT },
    timeout: 30000,
  });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function runJson(args) {
  const r = run(args);
  assert.equal(r.code, 0, `kanban.py ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('kanban.py feature inheritance and the goal kind', async (t) => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python not available');
    return;
  }
  t.after(() => rmSync(work, { recursive: true, force: true }));

  runJson(['init']);
  const P = runJson(['project', 'create', '--name', 'Owner', '--folder', 'owner-proj']).id;

  await t.test('a feature records the session that created it', () => {
    const feature = runJson(['feature', 'create', '--project', P, '--title', 'F',
      '--owner-session-id', 'ses_orchestrator']);
    assert.equal(feature.ownerSessionId, 'ses_orchestrator');
  });

  await t.test('a step delegated by the owner session joins the feature', () => {
    const step = runJson(['task', 'create', '--project', P, '--title', 'step',
      '--parent-session-id', 'ses_orchestrator']);
    
    assert.ok(step.worktreeBranch && step.worktreeBranch.startsWith('kanban/feature-'));
  });

  await t.test('a step of a step keeps the feature of its parent task', () => {
    const features = runJson(['feature', 'list', '--project', P]);
    const feature = features[0];
    const parent = runJson(['task', 'create', '--project', P, '--title', 'parent',
      '--session-id', 'ses_step', '--feature', feature.id]);
    assert.equal(parent.featureId, feature.id);
    const repair = runJson(['task', 'create', '--project', P, '--title', 'repair',
      '--parent-session-id', 'ses_step']);
    assert.equal(repair.featureId, feature.id);
  });

  await t.test('a task without a parent session gets no feature', () => {
    const lonely = runJson(['task', 'create', '--project', P, '--title', 'lonely']);
    assert.equal(lonely.featureId, null);
  });

  await t.test('the goal kind is valid and the watchdog does not block it', () => {
    const goal = runJson(['task', 'create', '--project', P, '--title', 'goal', '--kind', 'goal']);
    assert.equal(goal.kind, 'goal');
    // A goal that waits for the user must not be blocked by the stall watchdog.
    runJson(['task', 'update', goal.id, '--status', 'running', '--session-id', 'ses_goal']);
    const watched = runJson(['task', 'watch', '--default-timeout', '0']);
    assert.ok(!watched.stalled.some((t) => t.id === goal.id));
  });

  await t.test('an invalid kind is still rejected', () => {
    const r = run(['task', 'create', '--project', P, '--title', 'x', '--kind', 'nope']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Invalid kind|invalid choice/);
  });
});
