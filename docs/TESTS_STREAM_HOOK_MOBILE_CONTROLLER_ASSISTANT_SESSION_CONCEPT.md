# Tests for the stream hook, the mobile controller and the assistant session — concept

## Goal

Add unit tests for three front-end units of this repository: the live session
feed hook (`src/hooks/useSessionStream.ts`), the mobile board controller hook
(`src/mobile/useBoardData.ts`) and the board assistant session store
(`src/store/assistantSession.ts`). The tests run with the Node test runner
only, so the logic of these units is first moved into small framework-free
modules that the test process can import and call directly.

## Scope

### The concept covers

- The test cases for the three units, with one test name per case.
- The new helper modules that the implementation step must create first, and
  the reason for each one.
- The small, behaviour-preserving changes in the three production files that
  make the units reachable from the test process.
- The commands that the implementation step must run, and the expected result
  of each command.

### The concept does not cover

- The test code itself. It is written in the later implementation step.
- Any change of product behaviour. The extraction is a move of existing code.
  The one exception is the outcome reset of the stream runtime. It is listed
  under the new module and in the acceptance criteria.
- The desktop file `src/App.tsx`. It must not change.
- Any new test dependency. `package.json` keeps its current dependencies.
- The server, the scripts and the other front-end modules. They are not
  touched.
- Sharing code between the desktop and the mobile controller. The mobile
  controller is a copy of the desktop logic on purpose.

## Facts that constrain the plan (all verified in this worktree on 2026-10-21)

| Fact | Value |
| --- | --- |
| Test runner | `node:test` only. `npm test` = `node --test src/**/*.test.ts scripts/**/*.test.mjs server/**/*.test.mjs` |
| Test libraries | none. No vitest, no jsdom, no happy-dom, no React Testing Library |
| Node | v24.15.0 (TypeScript types are stripped at run time) |
| Base test result | `npm test` → 143 tests, 0 failures |
| Type check | `npm run typecheck` (`tsc --noEmit`) |
| Type check base result | **8 errors, already present at the branch base** (see below) |
| DOM in the test process | none. No `window`, no `document`, no `localStorage` |
| React in the test process | `react` can be imported, but no renderer exists. Hooks cannot be called |
| `tsconfig.json` | `allowImportingTsExtensions: true` and `noEmit: true` are already set, so `import x from './x.ts'` is valid TypeScript and valid for Vite |
| `node_modules` | present in this worktree. It is a junction to `C:\Users\rober\work\kanban\node_modules`. `npm test` and `npm run build` run here without any setup |

### The 8 type errors that exist at the branch base

`npm run typecheck` on the branch base reports these errors. They are not
caused by this feature. The main checkout holds uncommitted fixes for them, so
the feature branch does not have them.

```
src/components/AssistantChatWindow.tsx(179,32): error TS2345
src/components/AssistantChatWindow.tsx(235,24): error TS18047
src/components/AssistantChatWindow.tsx(249,24): error TS18047
src/components/AssistantChatWindow.tsx(283,24): error TS18047
src/components/AssistantChatWindow.tsx(284,46): error TS2345
src/mobile/MobileChat.tsx(133,32): error TS2345
src/prompts/boardAssistantPreamble.test.ts(29,94): error TS2345
src/prompts/boardAssistantPreamble.test.ts(46,59): error TS2345
```

The plan therefore contains **Task 1**, which fixes these 8 errors with three
small edits, so that `npm run typecheck` reports no error at the end of the
feature. The fixes are the same ones the main checkout already has.

### The branch base is behind the project branch

| Fact | Value |
| --- | --- |
| Branch base of this feature | `4d11f85` ("Fix assistant chat drag direction and vertical range") |
| Project branch `main` | `9733a6d` ("feat(worktree): per-task worktree isolation and feature orchestration") |
| Commits on main after the base | `a8185fe` (chat file preview, safe markdown links) and `9733a6d` (worktree isolation) |

Two facts follow from this and the plan must respect both:

1. `a8185fe` already contains the three fixes of Task 1. The feature branch
   still needs them, because its base is `4d11f85`. The implementation step
   must write the same lines as `a8185fe`. Then the merge of the feature
   branch into main does not conflict on these three files, because both
   sides change the same lines to the same text.
2. `9733a6d` adds worktree isolation to `src/mobile/useBoardData.ts`. It
   creates a worktree for a task, moves an old session into it, and adds the
   fields `worktreePath`, `worktreeBranch`, `worktreeState` and
   `worktreeNote` to the task. The feature branch does not have this code.
   The merge therefore touches the same function on both sides. The notes
   for the integrator are at the end of this document.

### The Node import rule

Node runs the test files as ES modules. A runtime import without the file
extension fails with `ERR_MODULE_NOT_FOUND`. The rule for this feature:

- A test file imports its module with the explicit extension:
  `import { runSessionStream } from './sessionStreamRuntime.ts';`
- A new module imports its runtime dependencies with the explicit extension:
  `import { toChatMessages } from '../components/chatEvents.ts';`
- A type-only import may keep the current style: `import type { Task } from '../types';`

This rule is verified: `src/store/assistantSession.ts` cannot be imported by
the test runner today, and it can be imported after the five import
specifiers get the `.ts` extension.

## Files

### New files (the implementation step creates them)

| Path | Reason |
| --- | --- |
| `src/hooks/sessionStreamRuntime.ts` | The stream hook is a React hook, so it cannot be called in the test process. This module holds the effect body and the pure helpers of the hook, without React. |
| `src/hooks/sessionStreamRuntime.test.ts` | The tests of the stream feed. |
| `src/mobile/boardController.ts` | The mobile controller is a React hook, so it cannot be called in the test process. This module holds the board state logic and the task start logic, without React. |
| `src/mobile/boardController.test.ts` | The tests of the mobile board controller. |
| `src/store/assistantSession.test.ts` | The tests of the assistant session store. The store is not a hook, so it is tested as it is. |

### Changed files (the implementation step changes them)

| Path | Change | Reason |
| --- | --- | --- |
| `src/hooks/useSessionStream.ts` | The effect body and the pure helpers move to `sessionStreamRuntime.ts`. The file keeps the hook, the same exported names and the same returned values. | The hook itself stays thin, so the feed logic can be tested. |
| `src/mobile/useBoardData.ts` | The board state helpers and the task start body move to `boardController.ts`. The file keeps the hook and the same returned values. | The controller logic can be tested. The desktop copy in `src/App.tsx` is not touched. |
| `src/store/assistantSession.ts` | The five runtime import specifiers get the `.ts` extension. No other change. | The test process must be able to import the store. |
| `src/hooks/autoContinue.ts` | `AutoContinueMessage.kind` also accepts `'event'`. | Task 1. Fixes 2 of the 8 base errors. |
| `src/components/AssistantChatWindow.tsx` | Three null guards for `project`. | Task 1. Fixes 4 of the 8 base errors. |
| `src/prompts/boardAssistantPreamble.test.ts` | The two fixture objects get `serverUrl: 'http://localhost'`. | Task 1. Fixes 2 of the 8 base errors. |

### Files that must not change

- `src/App.tsx` (desktop file).
- `package.json` and `package-lock.json` (no new dependency).
- `tsconfig.json` (the needed options are already set).
- `server/**`, `scripts/**` and all other test files.

## The new modules

### `src/hooks/sessionStreamRuntime.ts`

No React import. It must export exactly this surface.

```ts
export type ChatStatus = 'connecting' | 'live' | 'closed' | 'error' | 'idle' | 'no-run';

export interface SessionStreamState {
  messages: ChatMessage[];
  rawList: unknown[];
  status: ChatStatus;
  session: OpenCodeSessionInfo | null;
  outcome: string | null;
}

export interface SessionStreamOptions {
  sessionId: string | null;
  fetchMessages: (sessionId: string) => Promise<unknown[] | null>;
  getSession: (sessionId: string) => Promise<OpenCodeSessionInfo | null>;
  subscribeEvents: (sessionId: string, onEvent: () => void) => () => void;
  onState: (state: SessionStreamState) => void;
  pollMs?: number;   // default 2500
}

export interface SessionStreamRuntime {
  stop(): void;
  pollNow(): Promise<void>;
}

export function runSessionStream(opts: SessionStreamOptions): SessionStreamRuntime;
export function scanSessionList(list: unknown[]): { idleLike: boolean; outcome: string | null };
export function sessionErrorText(session: OpenCodeSessionInfo | null): string | null;
export function buildUsage(session: OpenCodeSessionInfo | null, rawList: unknown[], taskAgentName?: string | null): SessionUsage | null;
export function mergeChatMessages(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[];
```

Rules for the move:

- The code of `sessionErrorText`, `scanSessionList`, `buildUsage` (with `num`,
  `toMs` and `pickTokens`) and the message merge is moved unchanged.
- `runSessionStream` holds the current effect body: the first session lookup,
  the event subscription, the poll loop, the miss counter, the sequence guard
  and the cleanup. The order of the steps stays the same.
- The runtime owns the state. It reports every change through `onState`. The
  hook then puts the values into its own `useState` calls.
- The runtime starts with the status `idle` for a null session id and
  `connecting` for a session id, and it clears the messages and the raw list
  when it starts.
- The runtime resets the outcome to `null` when it starts. The old hook kept
  the previous outcome until the next poll. This difference is intended and
  is the only behaviour change of the move.
- `pollNow()` runs one poll and returns when it is done. The tests use it
  instead of waiting for the timer.
- The poll timer is cleared by `stop()`. After `stop()` no further fetch runs.

The hook `src/hooks/useSessionStream.ts` becomes:

```ts
export type { ChatStatus } from './sessionStreamRuntime';   // ChatFeed.tsx imports this type
export function useSessionStream(sessionId: string | null, opts?: { taskAgentName?: string | null }) { ... }
```

The hook keeps its returned object exactly:
`{ messages, status, session, sessionError, usage, outcome, retry }`.
`usage` is still `buildUsage(session, rawList, taskAgentName)`.

No test file imports the hook file. The hook file keeps the current import
style of the repository, so it may import the new module without the file
extension.

### `src/mobile/boardController.ts`

No React import. It must export exactly this surface.

```ts
export type TaskBuckets = Record<TaskStatus, Task[]>;
export interface OptimisticStamp { status: TaskStatus; at: number }

export const OPTIMISTIC_TTL_MS = 15000;

export function emptyBuckets(): TaskBuckets;
export function groupTasksByStatus(tasks: Task[]): TaskBuckets;
export function moveTaskToStatus(buckets: TaskBuckets, id: string, newStatus: TaskStatus): TaskBuckets;
export function upsertTaskInBuckets(buckets: TaskBuckets, task: Task): TaskBuckets;
export function applyOptimisticStamps(tasks: Task[], stamps: Record<string, OptimisticStamp>, now: number): Task[];
export function selectStartCandidates(running: Task[], startingIds: Iterable<string>): Task[];
export function resolveStartupAgent(task: Task, agents: Agent[]): { id: string; name?: string } | null;
export function newQueuedTaskId(now: number, suffix: string): string;
export function pickActiveProjectId(storedId: string | null, projects: Project[]): string | null;
export function assistantProjectFor(projects: Project[], activeProjectId: string | null): Project | null;

export interface TaskStartDeps {
  createSession: (opts: { title?: string; agent?: string; model?: { providerID: string; id: string }; directory?: string }) =>
    Promise<{ session: { id: string } | null; error?: string }>;
  sendPrompt: (sessionId: string, text: string, agent?: string) => Promise<{ ok: boolean; error?: string }>;
  getSessionInstruction: (sessionId: string, key: string) => Promise<string | null>;
  putSessionInstruction: (sessionId: string, key: string, value: string) => Promise<{ ok: boolean; error?: string }>;
  updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
  resolveModel: (task: Task, project: Project | null) => { providerID: string; id: string } | undefined;
  buildRunPrompt: (ctx: TaskPromptContext) => string;
  buildSessionInstruction: (ctx: TaskPromptContext) => string;
  buildFallbackPrompt: (ctx: TaskPromptContext) => string;
  instructionKey: string;
  language: string;
  onTask?: (task: Task) => void;
}

export interface TaskStartResult {
  task: Task;
  sessionId: string | null;
  phase: 'creating-session' | 'sending-prompt' | 'ready' | 'error';
  error?: string;
  prompt: string;
  instructionWritten: boolean;
}

export async function runTaskStart(deps: TaskStartDeps, task: Task, project: Project | null, agents: Agent[]): Promise<TaskStartResult>;
```

Rules for the move:

- `moveTaskToStatus` and `upsertTaskInBuckets` are the current
  `moveTaskInState` and `upsertTaskInState`, with the `setTasks` call removed.
  The returned object is a new object. An unknown task id returns the buckets
  unchanged.
- `applyOptimisticStamps` is the guard block of the current `loadData`. A task
  keeps its optimistic status while the stamp is younger than
  `OPTIMISTIC_TTL_MS` and the server reports another status. The stamp is
  removed when the server agrees with it or when the stamp is older.
- `selectStartCandidates` is the filter of the current start effect. A task is
  skipped when it is already starting, when it is `pendingSync`, or when it
  has a startup phase.
- `runTaskStart` is the body of the current `startTaskExecution`. It creates
  the session, writes the instruction entry once per session, sends the
  prompt and reports the phase. The `updateTask` calls and the `onTask`
  callback replace the `setTasks` calls of the old code.
- The `project` argument of `runTaskStart` is the project of the task. The
  hook finds it by `task.projectId`, exactly as the current code does. A task
  without a project gets `null`.
- The hook `src/mobile/useBoardData.ts` keeps its returned object exactly and
  calls the new functions. The desktop copy in `src/App.tsx` is not touched.

## Test cases

Every case below is one test in the file named next to it. The test name
states the behaviour, not the name of a function.

### A. The stream feed — `src/hooks/sessionStreamRuntime.test.ts` (19 cases)

| # | Test name | What it checks |
| --- | --- | --- |
| A1 | `a null session id keeps the feed idle and never asks the server` | No fetch and no event subscription. The status stays `idle`. |
| A2 | `a session id the server does not know reports no-run and does not poll` | The session lookup answers with nothing. The status is `no-run` and the message list is never fetched. |
| A3 | `one failed message fetch keeps the last known status` | The first fetch fails. The status is not `error` yet. |
| A4 | `two failed message fetches in a row report an error` | The second failure in a row sets the status `error`. |
| A5 | `a message fetch that works again clears the error state` | A successful fetch after a failure sets the status back to `closed` or `live`. |
| A6 | `an idle marker newer than the last chat message closes the stream` | The idle marker has the later time. The status is `closed`. |
| A7 | `an idle marker older than the last chat message keeps the stream live` | The idle marker has the earlier time. The status is `live`. |
| A8 | `an idle marker without a time is compared by its position in the list` | Neither row has a time. The marker after the chat message closes the stream. |
| A9 | `a session without any chat message is closed and ready for the first prompt` | A fresh session with no chat row is `closed`, not `live`. |
| A10 | `a tool row that changes from pending to completed is updated in place` | The same tool id changes its state. The feed keeps one row and the row shows `completed`. |
| A11 | `a stale poll response that arrives after a newer one does not change the feed` | The first poll answers late with old rows. The newer rows stay. |
| A12 | `the outcome of the session is reported to the caller` | The outcome of the session is given to the caller. |
| A13 | `the messages of a new session do not leak into the next session` | A new session id starts with an empty feed. |
| A14 | `the feed stops asking the server after the caller stops it` | After `stop()` no further fetch runs. |
| A15 | `the usage counts the tokens of the session` | The token counts of the session are reported. |
| A16 | `the usage adds up the tokens of the messages when the session reports none` | The token counts of the messages are added up. |
| A17 | `the usage is empty when there is no session and no message` | The usage is `null`. |
| A18 | `the session error text is read from the error field of the session` | The error field of the session becomes the error text. |
| A19 | `the session error text is empty when the session reports no error` | The error text is `null`. |

### B. The mobile board controller — `src/mobile/boardController.test.ts` (22 cases)

| # | Test name | What it checks |
| --- | --- | --- |
| B1 | `the tasks are grouped into the four board columns` | Every task lands in the column of its status. |
| B2 | `a moved task leaves its old column and joins the new one` | The task is gone from the old column and is in the new one. |
| B3 | `a task that is not on the board is not moved` | An unknown task id changes nothing. |
| B4 | `an updated task is removed from every other column` | The task exists in one column only, the column of its status. |
| B5 | `an optimistic move survives a server list that does not have it yet` | The server still reports the old status. The card keeps the new status. |
| B6 | `an optimistic move is dropped after fifteen seconds` | The stamp is older than 15 seconds. The server status wins. |
| B7 | `an optimistic move is dropped when the server agrees with it` | The server reports the new status. The stamp is removed. |
| B8 | `a queued create gets a real id and not a temporary one` | The id of a queued create starts with `q-` and never with `temp-`. |
| B9 | `a temporary card is replaced by the queued card after an offline create` | The temporary card is gone and the queued card carries the queued flag. |
| B10 | `only running tasks without a startup phase are started` | A task with a startup phase and a task that is not running are not started. |
| B11 | `a task that is already starting is not started a second time` | The id of the running task is in the list of the started tasks. |
| B12 | `a queued offline task is not started before it is replayed` | A task with the queued flag is not a candidate. |
| B13 | `the agent of the task is kept when the task has one` | The agent id of the task is used. |
| B14 | `the first agent of the list is used when the task has none` | The first agent of the list is used. |
| B15 | `a task start creates a session, writes the instruction and sends the prompt` | The session is created, the instruction entry is written once and the prompt is sent. The phase is `ready`. |
| B16 | `a task start reuses the session of the task and does not write the instruction again` | The session of the task is reused. No second session is created. The instruction is written only when it is missing. |
| B17 | `a task start sends the full prompt when the instruction entry cannot be written` | The failed instruction write leads to the full prompt. |
| B18 | `a task start reports the error when the prompt cannot be sent` | The phase is `error` and the error text is reported. |
| B19 | `the assistant session is started for the active project only` | The project of the active project id is the one that gets the assistant session. |
| B20 | `the first project becomes active when no project is stored` | The stored id is empty. The first project becomes the active one. |
| B21 | `a project switch shows only the tasks of the new project` | The columns hold only the tasks of the new project. |
| B22 | `an offline move keeps the card in the new column with the queued flag` | The move fails with a queued error. The card stays in the new column and gets the queued flag. |

### C. The assistant session store — `src/store/assistantSession.test.ts` (14 cases)

| # | Test name | What it checks |
| --- | --- | --- |
| C1 | `a stored session id is returned without asking the server` | The store has the id. The result is that id and no session is created. |
| C2 | `the first call creates a session and stores its id` | One session is created and its id is stored for the project. |
| C3 | `two calls at the same time share one session` | Two calls run at the same time. Only one session is created and both calls get the same id. |
| C4 | `a call after the first one finished reuses the stored id` | The second call after the first one finished creates no new session. |
| C5 | `a failed create reports the error and stores nothing` | The server refuses the create. The result has the error and no id is stored. |
| C6 | `a failed create does not block the next call` | A later call tries to create the session again. |
| C7 | `the stored model is used when the project allows it` | The stored model is in the create request. |
| C8 | `a stored model that the project does not allow is replaced by a model of the project` | The stored model is not in the pool. The first model of the pool is used. |
| C9 | `a project with no usable model sends no model` | The pool holds only broken entries. The create request has no model. |
| C10 | `the board-wide task model is used when the project allows it` | The board-wide task model is in the create request. |
| C11 | `the agent preference is stored and read back` | The agent of a project is stored and read back. |
| C12 | `an empty agent preference removes the stored value` | An empty agent id removes the stored agent. |
| C13 | `the stored session id is removed when the assistant session is cleared` | The clear function removes the id. |
| C14 | `the assistant preamble is written into the new session` | After the create, the preamble is written into the instruction entries of the new session. |

Total new cases: 19 + 22 + 14 = **55**. The test run must report at least
198 tests (143 base + 55) and 0 failures.

## Edge cases and how they are handled

### The stream feed

| Case | Handling |
| --- | --- |
| The session id is `null` | The status is `idle`. No fetch runs. The feed is empty. (A1) |
| The server does not know the session (404) | The session lookup answers with nothing. The status is `no-run` and the message list is never fetched. (A2) |
| Two failed fetches in a row | The first failure keeps the last status. The second failure sets `error`. A later success clears the error. (A3, A4, A5) |
| The idle marker is newer than the last chat message | The stream is `closed`. The times are compared, not the positions in the list. (A6) |
| The idle marker is older than the last chat message | The stream stays `live`. (A7) |
| A tool row changes from pending to completed | The row keeps its id. The feed replaces the row with the same id and shows the new state. (A10) |
| A stale poll response arrives after a newer one | The sequence guard drops the old answer. The feed keeps the newer rows. (A11) |
| The server list has no time stamp | The old rule applies: the position in the list decides. This is the fallback of the time rule. (A8) |
| The list is empty | The status is `closed` (no chat row means the agent parked). The raw list is still stored. |
| The event bus sends a frame for another session | The runtime ignores it. The subscription callback only reacts to its own session. |
| The caller stops the runtime | The timer is cleared, the event subscription is cancelled and no fetch runs again. (A14) |

### The mobile board controller

| Case | Handling |
| --- | --- |
| An offline move | The move fails with a queued error. The card stays in the new column and gets the queued flag. The card is not put back. (B22) |
| A queued create | The temporary card is removed. The card with the real `q-` id and the queued flag takes its place. (B8, B9) |
| An optimistic move that the server does not return | The server still reports the old status. The card keeps the new status for 15 seconds. (B5) |
| The optimistic stamp is older than 15 seconds | The server status wins. (B6) |
| A project switch | The columns hold only the tasks of the new project. (B21) |
| The first project becomes active | No project id is stored. The first project of the list becomes active. (B20) |
| A task is already starting | The id is in the list of the started tasks, so the task is not started again. (B11) |
| A queued offline task | The task has the queued flag. It is not a start candidate until the queue is replayed. (B12) |
| The prompt cannot be sent | The phase is `error` and the error text is reported. The task keeps its error text. (B18) |
| The instruction entry cannot be written | The full prompt is sent instead of the short one. (B17) |
| The session of the task already exists | The session is reused. The instruction entry is written only when it is missing. (B16) |
| The project has no path | The create of the session fails. The phase is `error`. This is the same rule as in the desktop copy. |

### The assistant session store

| Case | Handling |
| --- | --- |
| A stored session id | The id is returned at once. The server is not asked. (C1) |
| The first call | The session is created and the id is stored for the project. (C2) |
| Two parallel calls | The in-flight map gives both callers the same promise. Only one session is created. (C3) |
| A stored model that the project does not allow | The stored model is skipped. The first model of the project pool is used. (C8) |
| A project that allows no model at all | The pool holds only broken entries. No model is sent, so the server picks its default. (C9) |
| A project with an empty pool | An empty pool means no limit. The stored model is kept. (C7) |
| A failed create | The result has the error text. Nothing is stored. The in-flight entry is removed, so the next call tries again. (C5, C6) |
| The preamble write | It runs in the background after the create. The test waits for it before it checks the calls. (C14) |

## Acceptance criteria

- [ ] `docs/TESTS_STREAM_HOOK_MOBILE_CONTROLLER_ASSISTANT_SESSION_CONCEPT.md`
      exists and is the plan of this feature.
- [ ] `src/hooks/sessionStreamRuntime.ts` exists, has no React import, and
      exports the surface listed above.
- [ ] `src/hooks/useSessionStream.ts` uses the runtime, keeps the same
      exported names (`useSessionStream`, `ChatStatus`) and returns the same
      object `{ messages, status, session, sessionError, usage, outcome, retry }`.
- [ ] The stream runtime resets the outcome to `null` when it starts. This is
      the only behaviour change of the move.
- [ ] `src/hooks/sessionStreamRuntime.test.ts` holds the 19 cases A1 to A19
      with the exact names of the table above.
- [ ] `src/mobile/boardController.ts` exists, has no React import, and exports
      the surface listed above.
- [ ] `src/mobile/useBoardData.ts` uses the new module, keeps the same
      returned object, and keeps the same poll delay, optimistic stamps and
      auto-start rule.
- [ ] `src/mobile/boardController.test.ts` holds the 22 cases B1 to B22 with
      the exact names of the table above.
- [ ] `src/store/assistantSession.ts` is importable by the test runner. Its
      behaviour, its exported names and its storage keys do not change.
- [ ] `src/store/assistantSession.test.ts` holds the 14 cases C1 to C14 with
      the exact names of the table above.
- [ ] `src/App.tsx` is not changed.
- [ ] `package.json` and `package-lock.json` are not changed. No test library
      is added.
- [ ] `tsconfig.json` is not changed.
- [ ] The 8 type errors of the branch base are gone. `npm run typecheck`
      reports no error.
- [ ] The three fixes of Task 1 are the same lines as commit `a8185fe`, so
      the merge into `main` does not conflict on these three files.
- [ ] `npm test` reports 0 failures and at least 198 tests.
- [ ] The new test files use `import assert from 'node:assert/strict';` and
      `import test from 'node:test';`, and they import their module with the
      explicit `.ts` extension.
- [ ] The new test files do not use `window`, `document` or a real
      `localStorage`. They install their own storage on `globalThis` and they
      restore the real `fetch` at the end of each test.
- [ ] No test waits for a timer of 2.5 seconds. The poll is driven by
      `pollNow()`.
- [ ] The change is committed on the branch `kanban/feature-171f5ca9`. Nothing
      is merged and nothing is pushed.

## Risks and how to avoid them

| Risk | How to avoid it |
| --- | --- |
| The tests check behaviour that no longer exists. | Every test name states a behaviour the product needs today. The helper modules are a move of the current code, so the tests describe the current behaviour. If a behaviour is removed on purpose later, the test must change in the same commit. A test that fails without a product change is a bug in the test. |
| The production code changes while the tests are added. | The diff of `src/hooks/useSessionStream.ts`, `src/mobile/useBoardData.ts` and `src/store/assistantSession.ts` must contain only moved code and import specifiers. No new field, no new rule, no new log. The one intended difference (the outcome reset) is listed above. `src/App.tsx` stays as it is. |
| The chat breaks because the hook changed. | The hook keeps its exported names, its returned object and the order of its state changes. The type `ChatStatus` is still exported from `src/hooks/useSessionStream.ts`, so `src/components/ChatFeed.tsx` keeps working. |
| The mobile board breaks because the controller changed. | The hook keeps its returned object. The poll delay, the optimistic time of 15 seconds and the auto-start rule stay the same. The desktop copy in `src/App.tsx` is not changed and is not shared with the mobile copy. |
| Node cannot import a module. | Every runtime import in a new module and in the module under test gets the `.ts` extension. `allowImportingTsExtensions` is already set in `tsconfig.json`, and `npm run build` was checked with such an import. |
| The test process has no DOM. | The tests never read `window` or `document`. The assistant session store needs a storage, so the test installs a small storage object on `globalThis`. The store reads the global `localStorage`, so this works without changing the store. |
| A test is slow or flaky. | No test waits for a timer. The runtime takes the poll delay as a parameter and the test uses `pollNow()`. All fake answers are promises that the test controls. |
| The background write of the preamble runs after the test ends. | The test waits for the background work before it restores the fake `fetch`, and it counts the calls per URL instead of the total count of calls. |
| The state of one test leaks into the next test. | `node --test` runs every test file in its own process. Inside one file the test uses a different project id per case and empties the storage between the cases. |
| The type check stays broken. | Task 1 fixes the 8 base errors before the new work starts. The check at the end of the feature must report no error at all. |
| The test run cannot start because `node_modules` is missing. | The worktree has `node_modules` as a junction to the main checkout. The checks run without setup. If the junction is gone, the implementation step makes it again or runs `npm install`. The folder is in `.gitignore`, so it never enters the commit. |
| The merge with the main checkout conflicts. | The changes stay small and touch the same lines as the uncommitted work of the main checkout only in `src/hooks/autoContinue.ts`, `src/components/AssistantChatWindow.tsx` and `src/prompts/boardAssistantPreamble.test.ts`. The same change on both sides merges without a conflict. |
| The branch base is behind the project branch. | The branch base is `4d11f85`. The project branch `main` is at `9733a6d` and has two more commits. The plan lists the effect of both commits. The integrator notes at the end of this document say what to do when the merge conflicts in `src/mobile/useBoardData.ts`. |

## Required checks

Run these commands in the feature worktree
`C:\Users\rober\work\.kanban-worktrees\kanban\feature-171f5ca9-c410-4778-8169-b082caa11e57`.

| # | Command | Expected result |
| --- | --- | --- |
| 1 | `npm test` | 0 failures. At least 198 tests. No skipped test. The 143 base tests still pass. |
| 2 | `npm run typecheck` | No error. The command ends with exit code 0. |
| 3 | `npm run build` | The build ends with `✓ built`. No error. |
| 4 | `git status --short` | Only the planned files are listed. `node_modules/` and `dist/` do not appear. |

The `node_modules` of the worktree is already a junction to
`C:\Users\rober\work\kanban\node_modules`. The four checks of this table run
without any setup. If the junction is gone, make it again on Windows:

```
New-Item -ItemType Junction -Path node_modules -Target C:\Users\rober\work\kanban\node_modules
```

The command fails when the path already exists. Check it first with
`Test-Path node_modules`. The folder is in `.gitignore`, so it never enters
the commit.

## Task split for the implementation step

Each task owns its own files. No file is changed by two tasks.

| Task | Files | Work |
| --- | --- | --- |
| 1 | `src/hooks/autoContinue.ts`, `src/components/AssistantChatWindow.tsx`, `src/prompts/boardAssistantPreamble.test.ts` | Fix the 8 type errors of the branch base. The three edits must be the same lines as commit `a8185fe`, so the merge into main stays clean. `npm run typecheck` must report no error at the end of this task. |
| 2 | `src/hooks/sessionStreamRuntime.ts` (new), `src/hooks/useSessionStream.ts`, `src/hooks/sessionStreamRuntime.test.ts` (new) | Move the feed logic into the new module, make the hook a thin binding, and write the 19 cases A1 to A19. |
| 3 | `src/mobile/boardController.ts` (new), `src/mobile/useBoardData.ts`, `src/mobile/boardController.test.ts` (new) | Move the board state logic and the task start into the new module, wire the hook to it, and write the 22 cases B1 to B22. |
| 4 | `src/store/assistantSession.ts`, `src/store/assistantSession.test.ts` (new) | Add the `.ts` extension to the five runtime imports of the store and write the 14 cases C1 to C14. |
| 5 | none | Run the four checks, fix the failures inside the task that owns the file, and commit the feature branch. |

The order is 1, 2, 3, 4, 5. Task 5 does not write code of its own.

## Notes for the integrator

The merge of the feature branch into `main` will report a conflict in
`src/mobile/useBoardData.ts`. Both sides changed the same function. The
integrator must keep both parts:

1. The part of this feature: the hook calls the functions of the new module
   `src/mobile/boardController.ts` instead of holding the board state logic
   and the task start body itself.
2. The part of `main`: the worktree isolation of commit `9733a6d`. It creates
   a worktree for the task, moves an old session into it, and sets the fields
   `worktreePath`, `worktreeBranch`, `worktreeState` and `worktreeNote`. These
   steps belong inside the extracted `runTaskStart` of
   `src/mobile/boardController.ts`, because that function holds the task start
   body after the move.

The other files of this feature merge without a conflict. The three files of
Task 1 carry the same change on both sides.
