// Integration tests for the task-to-task link (parentTaskId) in server/kanban.py.
//
// The link must be automatic: a task that creates a task inside its own
// session becomes the parent of that task. The parent session is the only
// signal the callers have, so the server resolves the parent task from it.
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

const work = mkdtempSync(join(tmpdir(), 'kanban-parent-'));
const DB = join(work, 'kanban.db');
const ROOT = join(work, 'projects');
mkdirSync(ROOT, { recursive: true });

function run(args) {
  const r = spawnSync(PYTHON, [CLI, '--db', DB, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KANBAN_PROJECTS_ROOT: ROOT },
    timeout: 30000,
  });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function runJson(args) {
  const r = run(args);
  assert.equal(r.code, 0, `kanban.py ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('kanban.py task-to-task link', async (t) => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python not available');
    return;
  }
  t.after(() => rmSync(work, { recursive: true, force: true }));

  runJson(['init']);
  const P = runJson(['project', 'create', '--name', 'Parent', '--folder', 'parent-proj']).id;

  const parent = runJson(['task', 'create', '--project', P, '--title', 'Parent']).id;
  runJson(['task', 'update', parent, '--session-id', 'ses_parent']);

  await t.test('a task created in a task session gets the parent task automatically', () => {
    const child = runJson(['task', 'create', '--project', P, '--title', 'Child',
      '--parent-session-id', 'ses_parent']);
    assert.equal(child.parentTaskId, parent);
  });

  await t.test('a task without a parent session has no parent task', () => {
    const lonely = runJson(['task', 'create', '--project', P, '--title', 'Lonely']);
    assert.equal(lonely.parentTaskId, null);
  });

  await t.test('the link is filled in when the child gets its own session', () => {
    // The child was created before its session was known. When the session
    // arrives, the server links the grandchild to the child.
    const child = runJson(['task', 'create', '--project', P, '--title', 'Child2',
      '--parent-session-id', 'ses_parent']);
    const grand = runJson(['task', 'create', '--project', P, '--title', 'Grand',
      '--parent-session-id', 'ses_child2']);
    assert.equal(grand.parentTaskId, null); // not linked yet
    runJson(['task', 'update', child.id, '--session-id', 'ses_child2']);
    assert.equal(runJson(['task', 'show', grand.id]).parentTaskId, child.id);
  });

  await t.test('an explicit parent task id is stored', () => {
    const other = runJson(['task', 'create', '--project', P, '--title', 'Explicit',
      '--parent-task-id', parent]);
    assert.equal(other.parentTaskId, parent);
  });

  await t.test('an unknown parent task is rejected', () => {
    const r = run(['task', 'create', '--project', P, '--title', 'Bad',
      '--parent-task-id', 'no-such-task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Parent task not found/);
  });

  await t.test('a task from another project cannot be the parent', () => {
    const other = runJson(['project', 'create', '--name', 'Other', '--folder', 'other-proj']);
    const foreign = runJson(['task', 'create', '--project', other.id, '--title', 'Foreign']).id;
    const r = run(['task', 'create', '--project', P, '--title', 'Foreign',
      '--parent-task-id', foreign]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /another project/);
  });

  await t.test('a task cannot be its own parent', () => {
    const r = run(['task', 'update', parent, '--parent-task-id', parent]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Self-parent rejected/);
  });

  await t.test('children lists the tasks created inside a task', () => {
    const children = runJson(['task', 'children', parent]);
    const titles = children.map((c) => c.title).sort();
    assert.deepEqual(titles, ['Child', 'Child2', 'Explicit']);
    assert.ok(children.every((c) => c.parentTaskId === parent));
  });

  await t.test('the parent link can be cleared', () => {
    const cleared = runJson(['task', 'update', parent, '--parent-task-id', '']);
    assert.equal(cleared.parentTaskId, null);
  });

  await t.test('deleting a task clears the link of its children', () => {
    const child = runJson(['task', 'create', '--project', P, '--title', 'Doomed',
      '--parent-task-id', parent]);
    runJson(['task', 'delete', child.id]);
    const grand = runJson(['task', 'create', '--project', P, '--title', 'Orphan',
      '--parent-session-id', 'ses_doomed']);
    assert.equal(grand.parentTaskId, null);
  });

  await t.test('children of a missing task is a clean error', () => {
    const r = run(['task', 'children', 'ghost-task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Task not found/);
  });
});
