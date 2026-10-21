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
    // The commit gate: the merge is refused while the work is not committed.
    assert.notEqual(done.worktreeState, 'merged');
    assert.match(done.worktreeNote, /not committed/i);
    // The folder stays, so no work is lost.
    assert.equal(existsSync(wt.path), true);
    assert.equal(existsSync(join(wt.path, 'src', 'b.txt')), true);
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

  await t.test('the worktree has the board agent team, and the files stay out of the commits', () => {
    // The board owns the team. The project repo has no agents of its own.
    const task = runJson(['task', 'create', '--project', P, '--title', 'With agents']).id;
    const created = runJson(['worktree', 'create', task]);
    // The team of the board is in the worktree, although the project has none.
    assert.equal(existsSync(join(created.path, '.opencode', 'agents', 'coding-orchestrator.md')), true);
    assert.equal(existsSync(join(created.path, '.opencode', 'agents', 'coder.md')), true);
    // Git does not see the agent files: the team is not task work.
    assert.equal(git(created.path, 'status', '--porcelain').stdout, '');
    // The agent stages everything: the agent files stay out of the commit.
    writeFileSync(join(created.path, 'work.txt'), 'work\n');
    git(created.path, 'add', '-A');
    const staged = git(created.path, 'diff', '--cached', '--name-only').stdout;
    assert.equal(staged, 'work.txt');
  });

  await t.test('the merge refuses a worktree with uncommitted work', () => {
    const task = runJson(['task', 'create', '--project', P, '--title', 'Not committed']).id;
    const created = runJson(['worktree', 'create', task]);
    writeFileSync(join(created.path, 'dirty.txt'), 'not committed\n');
    const merged = runJson(['worktree', 'merge', task]);
    assert.equal(merged.ok, false);
    assert.equal(merged.merged, false);
    assert.match(merged.error, /not committed/);
    // The work is still in the worktree, and main is untouched.
    assert.equal(existsSync(join(created.path, 'dirty.txt')), true);
    assert.equal(git(REPO, 'show', 'HEAD:dirty.txt').code !== 0, true);
  });

  await t.test('a branch behind the project branch is rebased before the merge', () => {
    // Feature A lands. Feature B was cut from the old base and is now behind.
    const a = runJson(['task', 'create', '--project', P, '--title', 'A']).id;
    const wa = runJson(['worktree', 'create', a]);
    writeFileSync(join(wa.path, 'a.txt'), 'A\n');
    git(wa.path, 'add', '.');
    git(wa.path, 'commit', '-m', 'A');
    const b = runJson(['task', 'create', '--project', P, '--title', 'B']).id;
    const wb = runJson(['worktree', 'create', b]);
    writeFileSync(join(wb.path, 'b.txt'), 'B\n');
    git(wb.path, 'add', '.');
    git(wb.path, 'commit', '-m', 'B');
    // A is merged first, so B is behind.
    runJson(['task', 'move', a, 'done']);
    assert.equal(git(REPO, 'show', 'HEAD:a.txt').stdout, 'A');
    // B does not have A yet.
    assert.equal(existsSync(join(wb.path, 'a.txt')), false);
    // The sync moves B onto the current main.
    const synced = runJson(['worktree', 'sync', b]);
    assert.equal(synced.ok, true);
    assert.equal(synced.synced, true);
    assert.equal(existsSync(join(wb.path, 'a.txt')), true);
    // Now B merges cleanly and main has both.
    const merged = runJson(['worktree', 'merge', b]);
    assert.equal(merged.merged, true);
    assert.equal(git(REPO, 'show', 'HEAD:a.txt').stdout, 'A');
    assert.equal(git(REPO, 'show', 'HEAD:b.txt').stdout, 'B');
  });

  await t.test('a leftover worktree folder is removed without following a junction', () => {
    // A worktree can hold a node_modules junction to the main checkout. The
    // board removes a leftover folder before it cuts a new worktree, and it
    // must not walk through that junction: the files of the main project
    // would be deleted. (The Windows command `rmdir /s /q` does exactly
    // that. Never use it on a worktree folder.)
    const OUTSIDE = join(work, 'outside');
    mkdirSync(OUTSIDE, { recursive: true });
    writeFileSync(join(OUTSIDE, 'keep.txt'), 'keep\n');
    const task = runJson(['task', 'create', '--project', P, '--title', 'Junction']).id;
    // The leftover folder of the task: it is not registered as a worktree,
    // but it has the .git marker of one. The board removes such a folder
    // before it cuts a new worktree.
    const leftover = join(WT_ROOT, 'proj', task);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, '.git'), 'gitdir: fake\n');
    const link = join(leftover, 'link');
    const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, OUTSIDE], { encoding: 'utf8' }).status === 0;
    if (!made) { t.skip('this system cannot make a folder junction'); return; }
    const created = runJson(['worktree', 'create', task]);
    assert.equal(created.ok, true);
    // The folder outside is untouched.
    assert.equal(existsSync(join(OUTSIDE, 'keep.txt')), true,
      'the delete must not follow the junction');
    // The leftover folder is gone.
    assert.equal(existsSync(join(leftover, 'link')), false);
  });

  await t.test('the merge pushes the project branch to the remote', () => {
    // The board does the git work (option A): the merge is pushed.
    const REMOTE = join(work, 'remote.git');
    git(work, 'init', '--bare', REMOTE);
    git(REPO, 'remote', 'add', 'origin', REMOTE);
    git(REPO, 'push', '-u', 'origin', 'main');
    const task = runJson(['task', 'create', '--project', P, '--title', 'Pushed']).id;
    const created = runJson(['worktree', 'create', task]);
    writeFileSync(join(created.path, 'pushed.txt'), 'pushed\n');
    git(created.path, 'add', '.');
    git(created.path, 'commit', '-m', 'pushed');
    const merged = runJson(['worktree', 'merge', task]);
    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, true);
    assert.match(merged.pushNote, /pushed/);
    // The remote has the file.
    assert.equal(git(REMOTE, 'show', 'main:pushed.txt').stdout, 'pushed');
  });

  await t.test('a merge without a remote says so', () => {
    git(REPO, 'remote', 'remove', 'origin');
    const task = runJson(['task', 'create', '--project', P, '--title', 'No remote']).id;
    const created = runJson(['worktree', 'create', task]);
    writeFileSync(join(created.path, 'local.txt'), 'local\n');
    git(created.path, 'add', '.');
    git(created.path, 'commit', '-m', 'local');
    const merged = runJson(['worktree', 'merge', task]);
    // The merge works. Only the push is missing.
    assert.equal(merged.merged, true);
    assert.equal(merged.pushed, false);
    assert.match(merged.pushNote, /no remote/);
  });

  await t.test('the main checkout is never removed as a worktree', () => {
    // A wrong path must never reach `git worktree remove`: that command can
    // delete the files of the main repository.
    const task = runJson(['task', 'create', '--project', P, '--title', 'No worktree']).id;
    const removed = runJson(['worktree', 'remove', task, '--force']);
    assert.equal(removed.ok, false);
    assert.match(removed.error, /no worktree folder|not registered/);
    // The repository still has its files.
    assert.equal(existsSync(join(REPO, 'README.md')), true);
    assert.equal(git(REPO, 'status', '--porcelain').stdout.includes(' D'), false);
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
