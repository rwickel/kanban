# Result handoff — passing a result to the next task

> What changes, how it works, and what it does not do. The delegation
> contract is in `docs/WORKTREE_ISOLATION_CONCEPT.md`. The routes are in
> `docs/KANBAN_API.md`.

## Summary

- A **handoff** carries the result of one task into the next task. It is a
  separate channel. The result never goes into the task description.
- Two cases use the same channel:
  - **Case A — forward.** Task A is done. Its result becomes context of task B.
  - **Case B — carry over.** Task A moves to the next agent. The result of the
    last run of task A becomes context of the new run.
- The board stores the handoff as a **snapshot**. The source result cannot
  change the snapshot later.
- The handoff goes into the **run prompt** (Layer 3). It does not go into the
  session contract (Layer 2), because it changes with every run.
- The board keeps the handoff on a **ledger**. Each handoff is consumed once.

## The facts of the code

The design rests on these facts. Each one was checked in the code on
2026-10-22.

| Fact | Where |
|---|---|
| The result of a finished task is stored on the task row | `server/kanban.py`, `tasks.result` and `tasks.result_context` |
| The last assistant message of a session becomes the result | `vite.config.js`, the reconciler |
| The result is delivered to the parent session by a ledger, not by a caller | `server/kanban.py`, `task notify-pending` and `task notify-mark` |
| The delivery is a queued message, so a busy chat is not cut | `vite.config.js`, `POST /session/:id/prompt` with `delivery: "queue"` |
| The delivery is stamped only after the message was sent | `vite.config.js`, `notify-mark` after a 2xx |
| A re-start clears the result of the task | `vite.config.js`, `startExistingTask`: `--result ""` |
| The agent of a task can change on the row, but the session stays | `server/kanban.py`, `task update --agent-id` |
| The board owns the team of a project | `server/kanban.py`, `projects.agent_ids` |
| The model of a task is checked against the allowed list | `vite.config.js`, `validateTaskModel` |
| The prompt has three layers | `src/prompts/taskPrompt.ts` |
| The prompt is built in four places | see "The four prompt builders" |
| The description is the brief, the result is the answer | the rules of `src/prompts/taskPrompt.ts` |

**The gap in one line.** The result of a task reaches the parent session
and the card. It reaches no other task.

## Terms

| Term | Meaning |
|---|---|
| source task | the task that produced the result |
| target task | the task that receives the result as context |
| handoff | one stored snapshot of one source result, bound to one target task |
| carry-over | a handoff where the source task and the target task are the same |
| snapshot | the copied text of the result at the time of the handoff |
| consumption | the moment the run prompt of the target task carries the handoff |

## The problem before

A delegated result returns to the parent session only.

```
parent session ◀── link-back message ── task A (done)
       │
       │  the parent must now read the result and write it again
       ▼
    task B description  ← the parent copies the text by hand
```

Two gaps:

1. The parent session can only start task B with the text it copies. A long
   result is cut or lost. The source of the text is no longer visible.
2. When a task moves to the next agent, the new agent starts with nothing.
   The old agent's result stays on the card, but the new agent never sees it.

```
task A  agent: planner   status: done   result: "the plan is ..."
   │
   │  move to the next agent
   ▼
task A  agent: coder     status: running
        new session, new contract, no result
```

## After: one handoff channel

```
                     ┌───────────────────────────────┐
 parent session ◀────┤  handoff (snapshot)           │
   │  link-back       │  source: task A, result, ts  │
   │                 └───────────────┬───────────────┘
   │                                 │
   │                        (task A is done)
   │                                 │
   │                                 ▼
   │                 ┌───────────────────────────────┐
   │                 │  task B                      │
   │                 │  run prompt:                 │
   │                 │  "## Input from earlier work  │
   │                 │   - From task A (planner):   │
   │                 │     <result snapshot>"       │
   │                 └───────────────────────────────┘
   ▼
 result of task B returns to the parent session
```

The parent does not copy text. The board moves it.

## Data model

```
tasks ──┬── task_handoffs (one row per handoff)
        │      ├── id
        │      ├── task_id            the target task
        │      ├── source_task_id     the task that produced the result
        │      ├── source_session_id  the session of the source run
        │      ├── source_agent_id    the agent of the source run
        │      ├── kind               result | carry_over | note
        │      ├── content            the snapshot (result text, trimmed)
        │      ├── source_updated_at  when the source result was written
        │      ├── status             pending | consumed
        │      ├── created_at
        │      └── consumed_at
        │
        └── result                   the live result of the task
```

**Why a separate table and not a column.** A task can receive many handoffs
from many sources. A column can hold one value only. The table also keeps the
history: which source was used, and when it was consumed.

**Why a snapshot and not a live link.** The source result can change after the
handoff. A live link would change the context of a task without a new
instruction, and the agent could not tell what it received. The snapshot also
keeps the chain stable for the audit.

**Why `source_updated_at`.** The agent must know if the snapshot is old. The
run prompt prints the time of the snapshot. The agent can read the current
result with `GET /api/kanban/tasks/:id` when it needs more.

**The handoff and the link-back are separate.** The link-back ledger
(`notified_at`) says "the parent knows this result". A handoff says "the next
task uses this result". A handoff never changes `notified_at`, and a
link-back never creates a handoff.

## The two cases in detail

### Case A — forward a result to another task

1. Task A ends `done`. The board stores the result of A.
2. The parent calls `kanban_hand_off` with `fromTaskId: A` and `toTaskId: B`.
3. The board reads the result of A, trims it, and stores one handoff row.
4. The board refuses the handoff when A has no result, or when A and B are in
   different projects, or when A is not `done` or `blocked`.
5. When task B starts, the board reads the pending handoffs of B and puts them
   into the run prompt.

The handoff does not start task B. The board starts B only when the caller
says so (`startNow: true`) or when a user starts B later.

### Case B — move a task to the next agent (carry-over)

1. Task A ends `done` with a result. The agent is `planner`.
2. The parent calls `kanban_reassign` with `taskId: A` and `agentId: coder`.
3. The board checks that `coder` is on the team of the project
   (`projects.agent_ids`) and that the model of the new agent is allowed.
4. The board reads the result of A and stores one handoff row on A with
   `kind: carry_over`. The row names the old agent and the old session.
5. The board starts a new session for the new agent. The old session id stays
   in the event log, not in the task row.
6. The new run prompt carries the carry-over text.

The carry-over counts against the same caps as any other handoff.

**The carry-over must be stored before the result is cleared.** A re-start
clears the result today. See "The order of the operations on a re-assign".

**Today the agent can change without a new session.** The row has an
`agent_id`, the CLI has `task update --agent-id`, and the PATCH route accepts
`agentId`. But the session stays the session of the old agent, so the new
agent works in a session of the old agent. A real re-assign needs a new
session, a new contract and the carry-over.

**A blocked source is allowed.** The handoff then carries the blocker line
too, and the run prompt marks it: "source task is blocked". The next agent
knows that the input is not a finished result.

## Injection point

The handoff goes into the **run prompt** (Layer 3 of `src/prompts/taskPrompt.ts`),
not into the session contract (Layer 2).

| Layer | Lifetime | Carries the handoff? |
|---|---|---|
| Layer 1 — agent instructions | the agent | no |
| Layer 2 — session contract | installed once per session | no — it must stay stable |
| Layer 3 — run prompt | sent once per run | **yes** |

A handoff arrives after the session exists. A contract is installed once, so a
handoff would be lost in a later run. The run prompt changes with every run,
so it is the right place.

**The run prompt block.**

```
## Input from earlier work

- **From:** "Plan the API" (id 8f2c…, agent: planner, status: done)
  **Snapshot taken:** 2026-10-20 09:14:02
  **Result:** <the trimmed result text>

Read the full result with GET /api/kanban/tasks/8f2c… when you need more.
```

**The delegate prompt** (`opencode-plugin/delegate.js`) gets the same block.
A delegated task can start with the result of an earlier task in the same
call.

## The four prompt builders

The code today builds the prompt in **four** places. Each one must add the
same block.

| Builder | Used by | File |
|---|---|---|
| `buildTaskRunPrompt` | the desktop start, the mobile start | `src/prompts/taskPrompt.ts` |
| `buildDelegatePrompt` | the plugin delegate | `opencode-plugin/delegate.js` |
| the delegate prompt of the HTTP route | `POST /api/kanban/delegate` | `vite.config.js` |
| the prompt of `startExistingTask` | `POST /api/kanban/tasks/:id/start` | `vite.config.js` |

**One shared function.** The block and the caps live in a new pure module
`scripts/handoff.mjs`, next to `scripts/linkback.mjs`. The four builders call
it. A copy of the text in four files would drift.

```
buildHandoffBlock(handoffs) → "## Input from earlier work\n\n…" | ""
```

The pure module is unit tested, like `scripts/linkback.mjs`.

## The order of the operations on a re-assign

A re-start **clears the result** of the task today
(`vite.config.js`, `startExistingTask`: `--result "" --result-context ""`).
So the board must read the result **before** the reset.

```
1. read the result of the task        ← the old result
2. store the carry-over handoff        ← the snapshot
3. clear the result, start the new session
4. build the run prompt with the carry-over
```

If the board clears first, the carry-over is empty. The result is gone and
the new agent gets nothing.

## Rules

| Rule | Reason |
|---|---|
| The handoff is a snapshot. It does not change later. | the agent must know what it received |
| The result never goes into the task description. | the description is the brief, not the answer |
| Each handoff is consumed once. | a second run must not read the same input again |
| A handoff is not a dependency. | the target can start without the source |
| The board never creates a handoff on its own. | the parent decides what the next agent must know |
| A blocked source is allowed, but it is marked. | the next agent must see the blocker |
| A handoff never changes `notified_at`. | the link-back ledger stays correct |
| A handoff never changes `parentSessionId`. | the delivery chain stays correct |
| The snapshot is trimmed. The full text stays on the board. | the prompt must stay small |
| The carry-over is stored before the result is cleared. | a re-start clears the result |
| The new agent must be on the project team. | the board owns the team (`projects.agent_ids`) |
| The model of the new agent must be allowed. | `projects.allowed_models` and `validateTaskModel` |
| A re-assign starts a new session. | the new agent has its own contract and its own tools |

## Caps

| Limit | Value |
|---|---|
| Characters per source result | 2000 |
| Sources per run prompt | 3 |
| Total characters per run prompt | 6000 |
| Characters for a manual note | 1000 |

The oldest source is dropped first when the total is too large. The run
prompt then says that the list was cut, and names the dropped task ids. The
full result is always on the board.

## Use cases

### UC-1 — the result of task A becomes context of task B

**Actor**: `coding-orchestrator` **Precondition**: task A is `done` with a result

1. The orchestrator calls `kanban_hand_off` with `fromTaskId: A`, `toTaskId: B`.
2. The board stores one handoff row for B.
3. The orchestrator calls `kanban_delegate` for B, or the user starts B.
4. The run prompt of B holds the result of A under "Input from earlier work".
5. The handoff row becomes `consumed`.

**Result**: B starts with the work of A. Nobody copies text.

### UC-2 — a task moves to the next agent

**Actor**: `coding-orchestrator` **Precondition**: task A is `done` with a result

1. The orchestrator calls `kanban_reassign` with `taskId: A`, `agentId: coder`.
2. The board stores a carry-over handoff on A and starts a new session for the
   coder.
3. The run prompt of the coder holds the result of the planner.

**Result**: the new agent continues the old work. The old result is not lost.

### UC-3 — the source task has no result

**Actor**: `coding-orchestrator`

1. The orchestrator calls `kanban_hand_off` for a task without a result.
2. The board refuses the handoff and names the reason.

**Result**: no empty context. The caller knows what is missing.

### UC-4 — the target task is already running

**Actor**: `coding-orchestrator`

1. The board cannot change the run prompt of a running task.
2. The handoff stays `pending`. It is used by the next run of the target task.

**Result**: no lost input. The input arrives with the next run.

### UC-5 — the result is delivered to the parent and also to the next task

**Actor**: board **Precondition**: task A is `done`

1. The link-back delivers the result of A to the parent session and stamps
   `notified_at`.
2. The handoff of A to B is a separate record. It changes nothing on the
   link-back ledger.

**Result**: the parent knows the result once. The next agent reads the result
in its own prompt.

## Rules for the agents

- Read the "Input from earlier work" block before you plan.
- Use the input as a base, not as the brief. The brief is in "What to do".
- If the input is old or partial, read the source task with
  `GET /api/kanban/tasks/:id`.
- Do not write the input into the description. The description stays the brief.
- Do not write your own answer into the description. Use `kanban_task_result`.

## Surface

**Plugin tools**

| Tool | Purpose |
|---|---|
| `kanban_hand_off` | store the result of one task as context of another task |
| `kanban_reassign` | move a task to the next agent, with a carry-over |
| `kanban_delegate` | takes `fromTaskIds`, so a new task starts with inputs |
| `kanban_task_handoffs` | list the handoffs of a task, with the state |

**HTTP**

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/kanban/tasks/:id/handoffs` | add a handoff to a task |
| GET | `/api/kanban/tasks/:id/handoffs` | the handoffs of a task |
| POST | `/api/kanban/tasks/:id/reassign` | move the task to the next agent |

**CLI**

```
python server/kanban.py handoff add --to <taskId> --from <taskId> [--note "..."]
python server/kanban.py handoff list --task <taskId>
python server/kanban.py handoff consume --task <taskId>
```

## What changes in the code

| File | Change |
|---|---|
| `server/kanban.py` | the table `task_handoffs`, the CLI group `handoff`, the route data of a task, the event `task.handoff` |
| `scripts/handoff.mjs` | **new** — the pure block builder and the caps, with the tests |
| `opencode-plugin/index.ts` | the tools `kanban_hand_off`, `kanban_reassign`, `kanban_task_handoffs`; `kanban_delegate` takes `fromTaskIds` |
| `opencode-plugin/delegate.js` | the delegate prompt takes the inputs of the new task |
| `src/prompts/taskPrompt.ts` | the run prompt takes the inputs, and prints the "Input from earlier work" block |
| `vite.config.js` | the delegate route and `startExistingTask` read the pending handoffs and pass them to the prompt; the carry-over is stored before the result is cleared |
| `src/store/kanban.ts` | the client functions for the handoff routes |
| `src/components/TaskModal.tsx` | shows the handoffs of a task, with the source and the state |
| `src/types.ts` | the type `TaskHandoff` |
| `scripts/linkback.mjs` | the link-back message names the source of a task that continues another task |

## Rejected alternatives

| Idea | Why not |
|---|---|
| Write the result into the description of the next task | the description is the brief. The result would be lost in the next edit, and the source would be invisible |
| Let the next task read the source task itself | the next task may not know that the source exists, and the read costs one model pass. The handoff names the source in the prompt |
| Send the result again to the parent session | the parent already has it. The link-back ledger would deliver it twice |
| A live link to the source result | the context of the target would change without a new instruction |
| Reuse the session of the old agent for the new agent | the new agent has its own contract and its own tool set. A new session is clean |

## Limits

- The handoff is text only. Files, images and diffs stay on the board. The
  target agent must read them from the worktree or from the API.
- The snapshot is trimmed. The agent must fetch the full result when it needs
  the whole text.
- A handoff does not order the work. Use `blockedByTaskIds` when the target
  must wait for the source.
- The board never creates a handoff on its own. A parent that does not call
  the tool gives no input.
- The number of handoffs of a task is not limited. The caps apply to one run
  prompt, so old handoffs that were consumed do not cost prompt space.
- The result of the source can contain secrets. The rule "no secrets" of
  `AGENTS.md` applies to the source agent, not to the board.
- The block goes into four prompt builders. A copy of the text in each file
  would drift. Use the shared module `scripts/handoff.mjs`.

## Tests

| Area | File | Cases |
|---|---|---|
| the block and the caps | `scripts/handoff.test.mjs` | the block, the caps, the oldest source is dropped first, the dropped ids are named, no block without a handoff |
| the store | `server/kanban-handoff.test.mjs` | the row, the snapshot, the consume, a source without a result is refused, a foreign project is refused, the carry-over of the same task |
| the prompt | `src/prompts/taskPrompt.test.ts` | the run prompt holds the block, the session contract does not |

**Not covered by a test**: the agent behaviour after a handoff. That the
agent really uses the input and does not treat it as the brief. That is a
prompt rule. The run prompt states the rule, and the review step is the
check.

## See also

- `docs/WORKTREE_ISOLATION_CONCEPT.md` — the delegation and the feature chain.
- `docs/KANBAN_API.md` — the routes.
- `src/prompts/taskPrompt.ts` — the three prompt layers.
- `scripts/linkback.mjs` — the link-back of a result to the parent session.
