// Integration tests for task dependencies (blockedByTaskIds) in server/kanban.py.
// Runs the REAL CLI against a throw-away SQLite file — the same code path the
// HTTP middleware and the plugin use — so validation, persistence, cycle
// rejection and delete-cleanup are proven end-to-end.
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

const work = mkdtempSync(join(tmpdir(), 'kanban-deps-'));
const DB = join(work, 'kanban.db');
const ROOT = join(work, 'projects');
mkdirSync(ROOT, { recursive: true });

/** Run the CLI. Returns { code, stdout, stderr } — never throws on failure. */
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

/** Run + parse JSON; asserts exit code 0. */
function runJson(args) {
  const r = run(args);
  assert.equal(r.code, 0, `kanban.py ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('kanban.py task dependencies', async (t) => {
  // Skip cleanly when python is not available in this environment.
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python not available');
    return;
  }
  t.after(() => rmSync(work, { recursive: true, force: true }));

  // ---- setup: one project, three tasks ----
  runJson(['init']);
  const project = runJson(['project', 'create', '--name', 'Deps', '--folder', 'deps-proj']);
  const P = project.id;
  const A = runJson(['task', 'create', '--project', P, '--title', 'A']).id;
  const B = runJson(['task', 'create', '--project', P, '--title', 'B']).id;
  const C = runJson(['task', 'create', '--project', P, '--title', 'C']).id;

  await t.test('project create returns a row_to_task-compatible project row', () => {
    const created = runJson(['project', 'create', '--name', 'Created', '--folder', 'created-proj', '--id', 'project-created']);
    assert.equal(created.id, 'project-created');
    assert.equal(created.name, 'Created');
    assert.equal(created.folder, 'created-proj');
    assert.equal(created.allowedModels instanceof Array, true);
  });

  await t.test('task move updates status and task row fields', () => {
    const moved = runJson(['task', 'move', A, 'running', '--comment', 'start']);
    assert.equal(moved.status, 'running');
    assert.equal(moved.kind, 'oneshot');
    assert.deepEqual(moved.blockedByTaskIds, []);
    assert.equal(runJson(['task', 'show', A]).status, 'running');
  });

  await t.test('task update persists fields and resets startup state on running', () => {
    runJson(['task', 'update', A, '--startup-phase', 'ready', '--startup-error', 'old']);
    const updated = runJson(['task', 'update', A, '--status', 'running', '--title', 'Updated']);
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.status, 'running');
    assert.equal(updated.startupPhase, null);
    assert.equal(updated.startupError, null);
  });

  await t.test('watch blocks stale oneshot tasks but keeps services running', () => {
    const stale = runJson(['task', 'create', '--project', P, '--title', 'Stale', '--status', 'running', '--kind', 'oneshot']);
    const service = runJson(['task', 'create', '--project', P, '--title', 'Service', '--status', 'running', '--kind', 'service']);
    const result = runJson(['task', 'watch', '--default-timeout', '0']);
    assert.ok(result.stalled.some((item) => item.id === stale.id));
    assert.equal(runJson(['task', 'show', stale.id]).status, 'blocked');
    assert.equal(runJson(['task', 'show', service.id]).status, 'running');
  });

  await t.test('notify-pending returns finished tasks that have not been delivered', () => {
    const pending = runJson(['task', 'create', '--project', P, '--title', 'Pending', '--status', 'done', '--parent-session-id', 'parent-session']);
    runJson(['task', 'create', '--project', P, '--title', 'No parent', '--status', 'done']);
    const result = runJson(['task', 'notify-pending']);
    assert.deepEqual(result.map((item) => item.id), [pending.id]);
    assert.equal(pending.parentSessionId, 'parent-session');
  });

  await t.test('existing tasks stay compatible: field defaults to []', () => {
    assert.deepEqual(runJson(['task', 'show', A]).blockedByTaskIds, []);
    assert.deepEqual(runJson(['task', 'show', B]).blockedByTaskIds, []);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, []);
  });

  await t.test('due dates can be set, changed, and cleared', () => {
    const dated = runJson(['task', 'create', '--project', P, '--title', 'Dated', '--due-date', '2026-10-19']);
    assert.equal(dated.dueDate, '2026-10-19');
    assert.equal(runJson(['task', 'update', A, '--due-date', '2026-10-20']).dueDate, '2026-10-20');
    assert.equal(runJson(['task', 'update', A, '--due-date', '2026-10-21']).dueDate, '2026-10-21');
    assert.equal(runJson(['task', 'update', A, '--due-date', '']).dueDate, '');
    runJson(['task', 'delete', dated.id]);
  });

  await t.test('create with --blocked-by stores the relation', () => {
    const d = runJson(['task', 'create', '--project', P, '--title', 'D', '--blocked-by', `${A},${B}`]);
    assert.deepEqual(d.blockedByTaskIds, [A, B]);
    // Clean up so later dependents assertions only see A/B/C.
    runJson(['task', 'delete', d.id]);
  });

  await t.test('update sets the relation; duplicates and junk are normalized', () => {
    const task = runJson(['task', 'update', C, '--blocked-by', ` ${A} ,${A},, ${B}`]);
    assert.deepEqual(task.blockedByTaskIds, [A, B]);
  });

  await t.test('update with empty --blocked-by clears the list', () => {
    assert.deepEqual(runJson(['task', 'update', C, '--blocked-by', '']).blockedByTaskIds, []);
  });

  await t.test('invalid task id is rejected and nothing is written', () => {
    const r = run(['task', 'update', C, '--blocked-by', 'no-such-task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Invalid blocked-by task id/);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, []);
  });

  await t.test('self-dependency is rejected', () => {
    const r = run(['task', 'update', C, '--blocked-by', C]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Self-dependency rejected/);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, []);
  });

  await t.test('two-node cycle B <-> C is rejected', () => {
    runJson(['task', 'update', C, '--blocked-by', B]); // C -> B is fine
    const r = run(['task', 'update', B, '--blocked-by', C]); // would close B -> C -> B
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cycle/i);
    // The failed write changed nothing.
    assert.deepEqual(runJson(['task', 'show', B]).blockedByTaskIds, []);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, [B]);
  });

  await t.test('three-node cycle A -> B -> C -> A is rejected', () => {
    runJson(['task', 'update', C, '--blocked-by', '']); // reset to a clean graph
    runJson(['task', 'update', A, '--blocked-by', B]); // A -> B
    runJson(['task', 'update', B, '--blocked-by', C]); // B -> C
    const r = run(['task', 'update', C, '--blocked-by', A]); // would close C -> A -> B -> C
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cycle/i);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, []);
  });

  await t.test('dependency on a task in another project is rejected', () => {
    const other = runJson(['project', 'create', '--name', 'Other', '--folder', 'other-proj']);
    const x = runJson(['task', 'create', '--project', other.id, '--title', 'X']).id;
    const r = run(['task', 'update', A, '--blocked-by', x]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /same project/);
    assert.deepEqual(runJson(['task', 'show', A]).blockedByTaskIds, [B]); // unchanged
  });

  await t.test('deps read reports predecessors, dependents and readiness', () => {
    // Clean chain: B -> A, C -> B  (B waits for A, C waits for B).
    runJson(['task', 'update', A, '--blocked-by', '']);
    runJson(['task', 'update', B, '--blocked-by', A]);
    runJson(['task', 'update', C, '--blocked-by', B]);

    const depsC = runJson(['task', 'deps', C]);
    assert.deepEqual(depsC.blockedByTaskIds, [B]);
    assert.deepEqual(depsC.predecessors.map((p) => p.id), [B]);
    assert.equal(depsC.predecessors[0].exists, true);
    assert.equal(depsC.predecessors[0].status, 'backlog');
    assert.equal(depsC.predecessors[0].done, false);
    assert.equal(depsC.ready, false);

    const depsA = runJson(['task', 'deps', A]);
    assert.deepEqual(depsA.blockedByTaskIds, []);
    assert.deepEqual(depsA.dependents, [B]); // only B waits for A (D was deleted)
    assert.equal(depsA.ready, true); // no predecessors

    runJson(['task', 'move', A, 'done']);
    const bAfter = runJson(['task', 'deps', B]);
    assert.deepEqual(bAfter.blockedByTaskIds, [A]);
    assert.equal(bAfter.predecessors[0].done, true);
    assert.equal(bAfter.ready, true); // predecessor A is done
    assert.equal(runJson(['task', 'deps', C]).ready, false); // B still backlog
    runJson(['task', 'move', A, 'backlog']); // restore for later assertions
  });

  await t.test('deleting a task scrubs it from other blocked-by lists', () => {
    runJson(['task', 'delete', B]);
    assert.deepEqual(runJson(['task', 'show', C]).blockedByTaskIds, []);
    assert.deepEqual(runJson(['task', 'show', A]).blockedByTaskIds, []);
  });

  await t.test('deps on a missing task is a clean error', () => {
    const r = run(['task', 'deps', 'ghost-task']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Task not found/);
  });

  await t.test('relations survive a process restart (persisted in SQLite)', () => {
    // Every runJson() call is a fresh process; this makes the guarantee explicit:
    // write in one process, read in another, same bytes on disk.
    const e = runJson(['task', 'create', '--project', P, '--title', 'E']);
    runJson(['task', 'update', e.id, '--blocked-by', A]);
    const reread = runJson(['task', 'show', e.id]);
    assert.deepEqual(reread.blockedByTaskIds, [A]);
  });
});
