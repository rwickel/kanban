// Integration tests for per-task git worktree isolation in server/kanban.py.
// Runs the REAL CLI against a throw-away SQLite file and a REAL git repo, so
// worktree creation, isolation, merge and conflict handling are proven
// end-to-end (not mocked).
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

const work = mkdtempSync(join(tmpdir(), 'kanban-worktree-'));
const DB = join(work, 'kanban.db');
const ROOT = join(work, 'projects');
const WT_ROOT = join(work, 'worktrees');
const REPO = join(ROOT, 'proj');
mkdirSync(ROOT, { recursive: true });

/** Run the CLI. Returns { code, stdout, stderr } — never throws on failure. */
function run(args) {
  const r = spawnSync(PYTHON, [CLI, '--db', DB, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KANBAN_PROJECTS_ROOT: ROOT,
      KANBAN_WORKTREES_ROOT: WT_ROOT,
    },
    timeout: 60000,
  });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

/** Run + parse JSON; asserts exit code 0. */
function runJson(args) {
  const r = run(args);
  assert.equal(r.code, 0, `kanban.py ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Run git in the repo. */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

test('kanban.py task worktree isolation', async (t) => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python not available');
    return;
  }
  const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitProbe.status !== 0) {
    t.skip('git not available');
    return;
  }
  t.after(() => rmSync(work, { recursive: true, force: true }));

  // ---- setup: a real git repo with one commit on main ----
  mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-b', 'main');
  git(REPO, 'config', 'user.email', 'kanban@test.local');
  git(REPO, 'config', 'user.name', 'Kanban Test');
  writeFileSync(join(REPO, 'README.md'), 'base\n');
  mkdirSync(join(REPO, 'src'), { recursive: true });
  writeFileSync(join(REPO, 'src', 'a.txt'), 'a1\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-m', 'base');

  runJson(['init']);
  const project = runJson(['project', 'create', '--name', 'WT', '--folder', 'proj']);
  const P = project.id;
  const T1 = runJson(['task', 'create', '--project', P, '--title', 'T1']).id;
  const T2 = runJson(['task', 'create', '--project', P, '--title', 'T2']).id;
  const T3 = runJson(['task', 'create', '--project', P, '--title', 'T3']).id;

  await t.test('worktree create gives the task its own folder and branch', () => {
    const created = runJson(['worktree', 'create', T1]);
    assert.equal(created.ok, true);
    assert.equal(created.reused, false);
    assert.ok(created.path.startsWith(WT_ROOT), `unexpected worktree path: ${created.path}`);
    assert.equal(created.branch, `kanban/task-${T1.slice(0, 8)}`);
    assert.equal(existsSync(join(created.path, 'src', 'a.txt')), true);
    // The main repo is untouched by the worktree.
    assert.equal(git(REPO, 'status', '--porcelain').stdout, '');
    // The task row now knows the worktree.
    const task = runJson(['task', 'show', T1]);
    assert.equal(task.worktreePath, created.path);
    assert.equal(task.worktreeBranch, created.branch);
    assert.equal(task.worktreeState, 'active');
  });

  await t.test('two tasks get two separate folders', () => {
    const second = runJson(['worktree', 'create', T2]);
    assert.notEqual(second.path, runJson(['worktree', 'create', T1]).path);
    assert.notEqual(second.branch, runJson(['worktree', 'create', T1]).branch);
  });

  await t.test('worktree create is idempotent for the same task', () => {
    const first = runJson(['worktree', 'create', T1]);
    const again = runJson(['worktree', 'create', T1]);
    assert.equal(again.path, first.path);
    assert.equal(again.reused, true);
  });

  await t.test('work in the worktree does not touch the main repo', () => {
    const wt = runJson(['worktree', 'create', T1]);
    writeFileSync(join(wt.path, 'src', 'a.txt'), 'a2-from-task\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-m', 'task change');
    // Main repo still has the old content.
    assert.equal(git(REPO, 'show', 'HEAD:src/a.txt').stdout, 'a1');
  });

  await t.test('moving a task to done merges the worktree into the project branch', () => {
    const done = runJson(['task', 'move', T1, 'done']);
    assert.equal(done.status, 'done');
    assert.equal(done.worktreeState, 'merged');
    // The change is now in the main repo.
    assert.equal(git(REPO, 'show', 'HEAD:src/a.txt').stdout, 'a2-from-task');
    // A clean worktree is removed after the merge.
    assert.equal(existsSync(done.worktreePath), false);
  });

  await t.test('a worktree with uncommitted work is kept and reported', () => {
    const wt = runJson(['worktree', 'create', T3]);
    writeFileSync(join(wt.path, 'src', 'b.txt'), 'uncommitted\n');
    const done = runJson(['task', 'move', T3, 'done']);
    assert.equal(done.status, 'done');
    assert.equal(done.worktreeState, 'merged');
    assert.match(done.worktreeNote, /uncommitted/i);
    // The folder stays, so no work is lost.
    assert.equal(existsSync(wt.path), true);
  });

  await t.test('a conflicting task is reported, not merged', () => {
    const wt = runJson(['worktree', 'create', T2]);
    writeFileSync(join(wt.path, 'src', 'a.txt'), 'a2-from-other-task\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-m', 'conflicting change');
    // The main repo moves on, so the task branch now conflicts.
    writeFileSync(join(REPO, 'src', 'a.txt'), 'main-moved-on\n');
    git(REPO, 'add', '.');
    git(REPO, 'commit', '-m', 'main moves on');

    const done = runJson(['task', 'move', T2, 'done']);
    assert.equal(done.status, 'done');
    assert.equal(done.worktreeState, 'conflict');
    assert.ok(done.worktreeNote && done.worktreeNote.length > 0, 'conflict needs a note');
    // The main repo keeps its own version and is not left mid-merge.
    assert.equal(git(REPO, 'show', 'HEAD:src/a.txt').stdout, 'main-moved-on');
    assert.equal(git(REPO, 'status', '--porcelain').stdout, '');
  });

  await t.test('worktree list shows the worktrees of the project', () => {
    const list = runJson(['worktree', 'list', '--project', P]);
    assert.ok(list.length >= 2);
    assert.ok(list.some((item) => item.taskId === T1 && item.state === 'merged'));
    assert.ok(list.some((item) => item.taskId === T2 && item.state === 'conflict'));
  });

  await t.test('worktree remove deletes the folder', () => {
    const wt = runJson(['worktree', 'create', T2]);
    const removed = runJson(['worktree', 'remove', T2, '--force']);
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.equal(existsSync(wt.path), false);
    assert.equal(runJson(['task', 'show', T2]).worktreeState, 'removed');
  });

  await t.test('a re-run after the merge starts with a fresh session and worktree', () => {
    // T1 was merged and its worktree was removed. A re-run must not keep the
    // stale session id (it points into the removed folder).
    runJson(['task', 'update', T1, '--session-id', 'ses_stale']);
    const moved = runJson(['task', 'move', T1, 'running']);
    assert.equal(moved.status, 'running');
    assert.equal(moved.sessionId, null);
    assert.equal(moved.worktreePath, null);
    // A new worktree is created on the next start.
    const fresh = runJson(['worktree', 'create', T1]);
    assert.equal(fresh.ok, true);
    assert.equal(existsSync(fresh.path), true);
  });

  await t.test('the worktree has the current agent team, and the files stay out of the commits', () => {
    // A committed agent file and a new one, in the project of the board.
    const agents = join(REPO, '.opencode', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'planner.md'), '---\ndescription: old\nmode: primary\n---\n\nold\n');
    writeFileSync(join(agents, 'coding-orchestrator.md'), '---\ndescription: new\nmode: primary\n---\n\nnew\n');
    git(REPO, 'add', '.opencode/agents/planner.md');
    git(REPO, 'commit', '-m', 'add planner agent');

    const task = runJson(['task', 'create', '--project', P, '--title', 'With agents']).id;
    const created = runJson(['worktree', 'create', task]);
    // Both agent files are in the worktree.
    assert.equal(existsSync(join(created.path, '.opencode', 'agents', 'planner.md')), true);
    assert.equal(existsSync(join(created.path, '.opencode', 'agents', 'coding-orchestrator.md')), true);
    // Git does not see them: the team is not task work.
    assert.equal(git(created.path, 'status', '--porcelain').stdout, '');
    // The agent stages everything: the agent files stay out of the commit.
    writeFileSync(join(created.path, 'work.txt'), 'work\n');
    git(created.path, 'add', '-A');
    const staged = git(created.path, 'diff', '--cached', '--name-only').stdout;
    assert.equal(staged, 'work.txt');
    // The main checkout still shows the new agent file, so it stays committable.
    assert.match(git(REPO, 'status', '--porcelain').stdout, /coding-orchestrator\.md/);
  });

  await t.test('a task in a project without git fails with a clear error', () => {
    mkdirSync(join(ROOT, 'plain'), { recursive: true });
    const plain = runJson(['project', 'create', '--name', 'Plain', '--folder', 'plain']);
    const task = runJson(['task', 'create', '--project', plain.id, '--title', 'X']).id;
    const r = run(['worktree', 'create', task]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not a git repository/i);
  });
});
