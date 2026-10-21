// Integration tests for the feature worktree model in server/kanban.py.
// A feature owns ONE git worktree and ONE branch. All its tasks point at that
// folder. The board never merges a feature on its own: the integrator calls
// `feature merge`.
//
// Run via `npm test` (package.json test glob covers server/**/*.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'kanban.py');
const PYTHON = process.env.KANBAN_PYTHON || 'python';

const work = mkdtempSync(join(tmpdir(), 'kanban-feature-'));
const DB = join(work, 'kanban.db');
const ROOT = join(work, 'projects');
const WT_ROOT = join(work, 'worktrees');
const REPO = join(ROOT, 'proj');
mkdirSync(ROOT, { recursive: true });

function run(args) {
  const r = spawnSync(PYTHON, [CLI, '--db', DB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KANBAN_PROJECTS_ROOT: ROOT, KANBAN_WORKTREES_ROOT: WT_ROOT },
    timeout: 60000,
  });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function runJson(args) {
  const r = run(args);
  assert.equal(r.code, 0, `kanban.py ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

test('kanban.py feature worktree', async (t) => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('python not available'); return; }
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('git not available'); return; }
  t.after(() => rmSync(work, { recursive: true, force: true }));

  // ---- setup: a real git repo with one commit on main ----
  mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', 'user.email', 'kanban@test.local');
  git(REPO, 'config', 'user.name', 'Kanban Test');
  writeFileSync(join(REPO, 'README.md'), 'base\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-m', 'base');

  runJson(['init']);
  const project = runJson(['project', 'create', '--name', 'Feat', '--folder', 'proj']);
  const P = project.id;

  await t.test('feature create makes one worktree and one branch', () => {
    const feature = runJson(['feature', 'create', '--project', P, '--title', 'Feature A']);
    assert.ok(feature.id);
    assert.equal(feature.status, 'active');
    assert.ok(feature.worktreePath.startsWith(WT_ROOT), `unexpected path: ${feature.worktreePath}`);
    assert.match(feature.worktreeBranch, /^kanban\/feature-/);
    assert.equal(existsSync(join(feature.worktreePath, 'README.md')), true);
    // The branch is checked out in the feature folder.
    assert.equal(git(feature.worktreePath, 'branch', '--show-current').stdout, feature.worktreeBranch);
  });

  await t.test('a task of the feature carries the worktree location', () => {
    const features = runJson(['feature', 'list', '--project', P]);
    const F = features[0].id;
    const task = runJson(['task', 'create', '--project', P, '--title', 'Concept', '--feature', F]);
    assert.equal(task.featureId, F);
    assert.equal(task.worktreePath, features[0].worktreePath);
    assert.equal(task.worktreeBranch, features[0].worktreeBranch);
    assert.equal(task.worktreeState, 'active');
  });

  await t.test('the board does not merge a feature when a task ends done', () => {
    const features = runJson(['feature', 'list', '--project', P]);
    const F = features[0].id;
    const tasks = runJson(['task', 'list', '--project', P]);
    const concept = tasks.find((x) => x.title === 'Concept');
    // The teammate commits in the shared folder.
    writeFileSync(join(features[0].worktreePath, 'plan.md'), 'plan\n');
    git(features[0].worktreePath, 'add', '.');
    git(features[0].worktreePath, 'commit', '-m', 'concept plan');
    runJson(['task', 'move', concept.id, 'done']);
    // Nothing was merged: the main branch still has no plan.md.
    assert.equal(git(REPO, 'show', 'HEAD:plan.md').code !== 0, true);
    // The feature is still active.
    const after = runJson(['feature', 'show', F]);
    assert.equal(after.status, 'active');
  });

  await t.test('feature merge puts the feature branch into main', () => {
    const features = runJson(['feature', 'list', '--project', P]);
    const F = features[0].id;
    const merged = runJson(['feature', 'merge', F]);
    assert.equal(merged.ok, true);
    assert.equal(merged.merged, true);
    assert.equal(git(REPO, 'show', 'HEAD:plan.md').stdout, 'plan');
    const after = runJson(['feature', 'show', F]);
    assert.equal(after.status, 'done');
  });

  await t.test('a task with an unknown feature is rejected', () => {
    const r = run(['task', 'create', '--project', P, '--title', 'X', '--feature', 'no-such-feature']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Feature not found/);
  });

  await t.test('a feature of another project is rejected', () => {
    mkdirSync(join(ROOT, 'other'), { recursive: true });
    const other = runJson(['project', 'create', '--name', 'Other', '--folder', 'other']);
    const features = runJson(['feature', 'list', '--project', P]);
    const r = run(['task', 'create', '--project', other.id, '--title', 'X', '--feature', features[0].id]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /another project/);
  });

  await t.test('feature delete keeps the tasks but drops the link', () => {
    const features = runJson(['feature', 'list', '--project', P]);
    const F = features[0].id;
    const path = features[0].worktreePath;
    runJson(['feature', 'delete', F]);
    const tasks = runJson(['task', 'list', '--project', P]);
    const concept = tasks.find((x) => x.title === 'Concept');
    assert.equal(concept.featureId, null);
    // The worktree location is cleared too, so the task cannot point at a
    // folder that no longer exists.
    assert.equal(concept.worktreePath, null);
    assert.equal(concept.worktreeBranch, null);
    // The folder is gone.
    assert.equal(existsSync(path), false);
    const gone = run(['feature', 'show', F]);
    assert.notEqual(gone.code, 0);
    assert.match(gone.stderr, /Feature not found/);
  });

  await t.test('a conflicting feature merge is reported and not applied', () => {
    const F = runJson(['feature', 'create', '--project', P, '--title', 'Feature B']).id;
    const list = runJson(['feature', 'list', '--project', P]);
    const feature = list.find((x) => x.id === F);
    // The feature branch changes a file.
    writeFileSync(join(feature.worktreePath, 'shared.txt'), 'from feature\n');
    git(feature.worktreePath, 'add', '.');
    git(feature.worktreePath, 'commit', '-m', 'feature change');
    // Main moves on with another change to the same file.
    writeFileSync(join(REPO, 'shared.txt'), 'from main\n');
    git(REPO, 'add', '.');
    git(REPO, 'commit', '-m', 'main change');
    const merged = runJson(['feature', 'merge', F]);
    assert.equal(merged.ok, false);
    assert.equal(merged.merged, false);
    assert.equal(merged.conflict, true);
    // Main keeps its own version and is not left mid-merge.
    assert.equal(git(REPO, 'show', 'HEAD:shared.txt').stdout, 'from main');
    assert.equal(git(REPO, 'status', '--porcelain').stdout, '');
    // The feature keeps the conflict note and stays active.
    const after = runJson(['feature', 'show', F]);
    assert.equal(after.status, 'active');
    assert.ok(after.mergeNote && after.mergeNote.length > 0, 'the conflict needs a note');
  });

  await t.test('only one step of a feature runs at a time', () => {
    const F = runJson(['feature', 'create', '--project', P, '--title', 'Feature C']).id;
    const a = runJson(['task', 'create', '--project', P, '--title', 'Step A', '--feature', F]).id;
    const b = runJson(['task', 'create', '--project', P, '--title', 'Step B', '--feature', F]).id;
    runJson(['task', 'move', a, 'running']);
    // A second running task of the same feature is refused: one writer.
    const r = run(['task', 'move', b, 'running']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Feature worktree is busy/);
    assert.equal(runJson(['task', 'show', b]).status, 'backlog');
    // The same rule holds for the update path (the drag and drop of the UI).
    const u = run(['task', 'update', b, '--status', 'running']);
    assert.notEqual(u.code, 0);
    assert.match(u.stderr, /Feature worktree is busy/);
    // A refused change must not change anything. The task was still written
    // as 'running' before the rule was checked, and two steps wrote into one
    // feature worktree.
    assert.equal(runJson(['task', 'show', b]).status, 'backlog');
    // After the first step ends, the next one may start.
    runJson(['task', 'move', a, 'done']);
    const ok = runJson(['task', 'move', b, 'running']);
    assert.equal(ok.status, 'running');
  });

  await t.test('a live session is not armed again', () => {
    const task = runJson(['task', 'create', '--project', P, '--title', 'Live session']);
    runJson(['task', 'update', task.id, '--session-id', 'ses_live', '--startup-phase', 'ready']);
    runJson(['task', 'move', task.id, 'running']);
    // A status change resets the handshake: the board starts the task.
    assert.equal(runJson(['task', 'show', task.id]).startupPhase, null);
    runJson(['task', 'update', task.id, '--session-id', 'ses_live', '--startup-phase', 'ready']);
    runJson(['task', 'move', task.id, 'blocked']);
    // The reconciler un-blocks a task whose session is alive. The handshake
    // must stay, or the board tab starts the task a second time.
    runJson(['task', 'update', task.id, '--status', 'running', '--keep-startup-phase']);
    const row = runJson(['task', 'show', task.id]);
    assert.equal(row.status, 'running');
    assert.equal(row.startupPhase, 'ready');
  });

  await t.test('a nested step keeps the delegation chain', () => {
    const F = runJson(['feature', 'create', '--project', P, '--title', 'Feature D']).id;
    const list = runJson(['feature', 'list', '--project', P]);
    const feature = list.find((x) => x.id === F);
    // The orchestrator step (parent) and the coder step (child of the parent).
    const parent = runJson(['task', 'create', '--project', P, '--title', 'Orchestrator',
      '--feature', F, '--parent-session-id', 'ses_parent']).id;
    const child = runJson(['task', 'create', '--project', P, '--title', 'Coder',
      '--feature', F, '--parent-session-id', 'ses_parent',
      '--blocked-by', parent]).id;
    const childRow = runJson(['task', 'show', child]);
    assert.equal(childRow.parentSessionId, 'ses_parent');
    assert.deepEqual(childRow.blockedByTaskIds, [parent]);
    // The child works in the same feature folder as the parent.
    assert.equal(childRow.worktreePath, feature.worktreePath);
    assert.equal(childRow.worktreeBranch, feature.worktreeBranch);
    // The child waits for the parent.
    const deps = runJson(['task', 'deps', child]);
    assert.equal(deps.ready, false);
    runJson(['task', 'move', parent, 'done']);
    assert.equal(runJson(['task', 'deps', child]).ready, true);
  });

  // The board tab starts every running task that has no startup phase. A
  // delegate starts the task itself, so it must leave a phase behind. Without
  // it the tab starts a second session for the same task: two features, two
  // steps, two merges.
  await t.test('a merged feature moves its completed tasks to the archive', () => {
    const F = runJson(['feature', 'create', '--project', P, '--title', 'Feature E']).id;
    const list = runJson(['feature', 'list', '--project', P]);
    const feature = list.find((x) => x.id === F);
    const step = runJson(['task', 'create', '--project', P, '--title', 'Step E1', '--feature', F]).id;
    const open = runJson(['task', 'create', '--project', P, '--title', 'Step E2', '--feature', F]).id;
    // The step is finished, the other one still waits.
    writeFileSync(join(feature.worktreePath, 'e.txt'), 'E\n');
    git(feature.worktreePath, 'add', '.');
    git(feature.worktreePath, 'commit', '-m', 'E');
    runJson(['task', 'move', step, 'done']);
    const merged = runJson(['feature', 'merge', F]);
    assert.equal(merged.merged, true);
    // The completed step is archived.
    assert.equal(runJson(['task', 'show', step]).status, 'archived');
    // The step that never ran stays visible.
    assert.equal(runJson(['task', 'show', open]).status, 'backlog');
    // The result of the step is kept.
    assert.equal(runJson(['task', 'show', step]).title, 'Step E1');
  });

  await t.test('a delegate keeps the startup phase when it starts the task', () => {
    const task = runJson(['task', 'create', '--project', P, '--title', 'Delegated step']);
    // A normal move resets the phase: the board starts the task.
    runJson(['task', 'move', task.id, 'running']);
    assert.equal(runJson(['task', 'show', task.id]).startupPhase, null);
    // The delegate passes its own phase: the board leaves the task alone.
    runJson(['task', 'move', task.id, 'backlog']);
    runJson(['task', 'move', task.id, 'running', '--startup-phase', 'sending-prompt']);
    assert.equal(runJson(['task', 'show', task.id]).startupPhase, 'sending-prompt');
    // The phase is set before the task runs, never after.
    const order = runJson(['task', 'show', task.id]);
    assert.equal(order.status, 'running');
    assert.equal(order.startupPhase, 'sending-prompt');
  });

  await t.test('a delegate that starts the task leaves a mark without a phase', () => {
    const task = runJson(['task', 'create', '--project', P, '--title', 'Delegated by the agent']);
    // The delegate actor starts the task. The board must not start it again.
    runJson(['task', 'move', task.id, 'running', '--actor', 'delegate']);
    assert.equal(runJson(['task', 'show', task.id]).startupPhase, 'sending-prompt');
    // The delegate writes the session and the phase "ready" afterwards.
    runJson(['task', 'update', task.id, '--actor', 'delegate', '--session-id', 'ses_x', '--startup-phase', 'ready']);
    assert.equal(runJson(['task', 'show', task.id]).startupPhase, 'ready');
  });
});
