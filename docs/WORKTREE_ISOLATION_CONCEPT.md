# Worktree isolation and feature orchestration

> What changed, how it works, and what it does not do. The design of the
> feature mode is in `vmodel/feature-worktree-orchestration/concept-design.md`.
> The routes are in `docs/KANBAN_API.md`.

## Summary

- Every task runs in **its own git worktree**. Two parallel tasks never share
  files, git index or build output. The board merges the branch when the task
  reaches `done`.
- A **feature** groups the steps of one unit of work. All its steps share
  **one** worktree and **one** branch. The board never merges a feature. The
  `integrator` agent does it, always into the project branch.
- Every task row carries **where its work happens**: `worktreePath`,
  `worktreeBranch`, `worktreeState`.
- The board assistant receives the worktree state with every result.

## Terms

| Term | Meaning |
|---|---|
| `board-manager` | the agent that is the user interface and the product owner |
| `coding-orchestrator` | the agent that owns one feature: worktree, steps, delegation |
| feature | a group of tasks that share one worktree and one branch |
| step | one task of a feature |
| project branch | the branch a project is pinned to (`projects.gitBranch`, `main` in this setup) |
| task branch | `kanban/task-<taskId>` — one branch per task |
| feature branch | `kanban/feature-<featureId>` — one branch per feature |

## The problem before

```
                    ┌──────────────────────────────┐
board assistant ──▶ │  C:\work\kanban               │  ← one folder, one git index
                    │  src/App.tsx   ← agent A      │
                    │  src/App.tsx   ← agent B      │  ← last write wins
                    │  dist/         ← agent A      │
                    └──────────────────────────────┘
```

Two tasks in one folder fight over files, over the git index and over the
build output. A merge is not possible, because there is no branch per task.

## After: one worktree per task

```
  task A                         task B
    │                              │
    ▼                              ▼
┌───────────────────┐        ┌───────────────────┐
│ .kanban-worktrees/│        │ .kanban-worktrees/│
│  proj/A           │        │  proj/B           │
│  kanban/task-A    │        │  kanban/task-B    │
└───────────────────┘        └───────────────────┘
        │                              │
        └──────────┐        ┌──────────┘
                   ▼        ▼
            ┌─────────────────────┐
            │  C:\work\kanban     │  ← project branch (main)
            └─────────────────────┘
              merge when the task is done
```

## After: one worktree per feature

```
  feature F
  worktree: .kanban-worktrees/proj/feature-F
  branch:   kanban/feature-F
        │
        ├── step 1  concept        planner      ┐
        ├── step 2  implementation  coder        │ one writer at a time
        ├── step 3  verification    testing      │ (the board refuses a
        ├── step 4  review         reviewer     │  second running step)
        └── step 5  merge          integrator   ┘ → merges into the project branch
```

## The life of a feature

```
user            board-manager      coding-orchestrator    team      integrator
 │                   │                     │                │            │
 │ "add feature X"  │                     │                │            │
 │──────────────────▶│                     │                │            │
 │                   │ delegate           │                │            │
 │                   │────────────────────▶│                │            │
 │                   │                     │ kanban_feature create            │
 │                   │                     │ → worktree + kanban/feature-F   │
 │                   │                     │                │            │
 │                   │                     │ delegate step 1 (concept)      │
 │                   │                     │────────────────▶│            │
 │                   │                     │                │ commit     │
 │                   │                     │                │            │
 │                   │                     │ delegate step 2 (blocked by 1) │
 │                   │                     │────────────────▶│            │
 │                   │                     │                │ commit     │
 │                   │                     │                │            │
 │                   │                     │ delegate step 3, 4              │
 │                   │                     │────────────────▶│            │
 │                   │                     │                │ commit     │
 │                   │                     │                │            │
 │                   │                     │ delegate step 5 (merge)        │
 │                   │                     │────────────────────────────▶│
 │                   │                     │                │ kanban_feature
 │                   │                     │                │ merge      │
 │                   │                     │                │ → project  │
 │                   │                     │                │   branch   │
 │                   │◀────────────────────┴────────────────┴────────────┘
 │  "feature X is in main"                │  the board queues the result of
 │◀──────────────────────────────────────┘  every step into the parent session
```

**Waiting or blocking — one model.** The steps are chained with
`blockedByTaskIds`. A step that is not ready stays in the backlog. The
orchestrator does **not** wait: it uses `wait: false` and the board queues the
result of the step into the orchestrator session. The orchestrator starts the
next step when the result arrives. `wait: true` exists for a caller that must
have the finished result in its own tool return; it is not needed here and it
keeps the calling session busy.

**The completion marker and the result are two different things.**

| | What it does |
|---|---|
| the result | the board queues it into the parent session, **also when the step ends `blocked`** |
| the marker | the board reads the last message: `KANBAN_TASK_COMPLETE` → the step is `done`; anything else → the step is `blocked` with the reason "completion was not verified" |

Only a `done` predecessor releases the next step of a feature. A `blocked`
step stops the chain, and the orchestrator decides: fix it in the same
worktree, or send the step again. The result is delivered either way, so the
orchestrator always knows what happened.

## How the board reads a running session

The board watches every running task and reads its OpenCode session.

| Session state | The board does |
|---|---|
| the turn ended with `KANBAN_TASK_COMPLETE` | the task is `done` |
| the turn ended with `KANBAN_TASK_INCOMPLETE` | the task is `blocked` — **unless** it has sub-tasks that still run |
| the turn ended without the marker | the task is `blocked` — **unless** it has sub-tasks that still run |
| the turn ended without the marker, and sub-tasks are running | the task stays `running` and waits for their results |
| the session failed | the task is `blocked` with the error of the session |
| the session was interrupted or aborted | the task is `blocked`. It is **not** re-armed |
| the session is idle and waits for the next message | **nothing**. An idle session is waiting, not stuck. |
| the session works and is silent for 10 minutes | the task is `blocked` (stale) and the session is interrupted |
| the task is `blocked` and its session still works | the task goes back to `running` |

Three rules matter for the orchestration:

- **A delegating agent ends its turn before the delegated work is done.** The
  board keeps such a task `running` as long as its sub-tasks run. The
  orchestrator wakes up when the board queues their results into its session.
  It must not write `KANBAN_TASK_INCOMPLETE` while it waits: the marker means
  the work is really not done.
- **A delegating agent must not sleep or poll.** A sleep loop blocks its own
  session, and the board cannot deliver a result into a busy session. It sends
  one `kanban_heartbeat` with the progress and ends the turn.
- **A task that stays `running` keeps its startup handshake.** The board does
  not start it a second time. Only a real status change (for example
  `backlog → running`) resets the handshake and starts the task.
- **The activity of a session is the newest of three clocks.** The last
  message, the update time of the session, and the heartbeat of the task. The
  last message alone is not enough: a delegating agent writes its last
  message and waits. The board delivers the result of the sub-task and the
  agent starts to work — but with a slow model the first new message takes
  minutes. With the old clock the board called that "stale" and interrupted
  a working session in the middle of its turn.

## The delivery: exactly once

The board delivers the result of a finished task into the parent session
(every 15 seconds). The rules that keep it to one delivery:

- **One delivery loop.** The reconciler state lives on `globalThis`. A config
  reload replaces the loop instead of adding a second one. With two loops the
  same result was delivered again and again.
- **Mark before the post.** The task is stamped as delivered before the
  message is posted, so two passes can never post it twice. If the post fails,
  the stamp is cleared (`task notify-unmark`) and the next pass tries again.
- **A stopped session is not re-armed.** An interrupted session is final. If
  the task were re-armed, it would flip between `blocked` and `running`, and
  every flip would deliver the result again.

## A task is started only once

The board tab starts every task that is `running` and has no startup phase.
A delegate starts the task itself, so the two must not fight over it.

The rule: **a task that is `running` always has a startup phase.**

| Who starts the task | The phase |
|---|---|
| the board tab (a card that was dragged to `running`) | none — the tab starts it |
| a delegate (`task move ... running --actor delegate`) | `sending-prompt`, then `ready` |

Without this, the race is short but real: the delegate moves the task to
`running` and writes the session id one second later. The tab polls in
between, sees a running task with no phase, and opens a **second** session
for the same task. Two orchestrators then make two features, two concept
steps and two merges of the same work.

The delegate marks the task before the move, not after:

```
task create                      → backlog, no session
task update --session-id X \
              --startup-phase sending-prompt
task move running --startup-phase sending-prompt   → running + phase
send the prompt
task update --startup-phase ready
```

The safety net: a task that stays in `sending-prompt` for two minutes
without a session is `blocked` with the note "The delegate did not finish
the setup of this task."

## Data model

```
projects ──┬── tasks (one row each)
           │      ├── worktree_path      where the work happens
           │      ├── worktree_branch    which branch
           │      ├── worktree_state     active | merged | conflict | pending | removed
           │      ├── worktree_note      merge result, conflict, session loss
           │      ├── feature_id ────────┐
           │      └── parent_session_id  │
           │                             │
           └── features ─────────────────┘
                  ├── id, title, description
                  ├── status              active | done
                  ├── worktree_path       one folder for all steps
                  ├── worktree_branch     one branch for all steps
                  ├── base_branch         the branch it started from
                  └── merge_note          conflict or error text
```

**Source of truth.** The `features` row owns the worktree path and the branch
of a feature. A task row of a feature holds a **copy** of both, written when
the task is created, so the board can show the location without a join. The
copy cannot drift: the worktree of a feature never changes after the feature
is created. Deleting the feature clears the copy on its tasks.

## Use cases

### UC-1 — two tasks run in parallel without interference

**Actor**: `board-manager` **Precondition**: the project is a git repository

1. The board manager delegates task A and task B.
2. The board creates `.kanban-worktrees/proj/A` and `.../B` with the branches
   `kanban/task-A` and `kanban/task-B`.
3. Each agent session starts in its own folder.
4. Agent A writes `src/App.tsx` in A. Agent B writes `src/api.ts` in B.
5. Task A ends `done`. The board merges `kanban/task-A` into the project
   branch.
6. Task B ends `done`. The board merges `kanban/task-B` into the project
   branch.

**Result**: no file is written twice. Both changes are in the project branch.

### UC-2 — an old task with an old session is started again

**Actor**: user **Precondition**: the task has a session from an earlier run

1. The user moves the task to `running`.
2. The board creates the worktree of the task.
3. The old session still points to the old folder, so the board **moves** the
   session into the new worktree. The chat history stays.
4. If the move fails, the board drops the session id and starts a new session
   in the worktree. The task gets the note "the old session could not move".
   The loss is visible on the card, never silent.
5. The task contract is written again, so the agent knows the worktree rules.

**Result**: the agent works in the worktree, not in the project folder.

### UC-3 — a feature is split into steps

**Actor**: `coding-orchestrator` **Precondition**: the feature exists

1. The orchestrator creates the feature: one worktree, one branch.
2. It delegates the concept step with `featureId`. The task row carries the
   feature folder and branch.
3. The concept agent works in the feature folder and commits the plan on the
   feature branch.
4. The orchestrator gets the result from the board, then delegates the
   implementation step with `blockedByTaskIds: [concept]`.
5. The implementation agent starts in the **same folder** and sees the plan
   file from step 3.

**Result**: the steps build on each other without cherry-picks and without a
merge between the steps.

### UC-4 — the integrator merges the feature into the project branch

**Actor**: `integrator` **Precondition**: the review step is `done`

1. The orchestrator delegates the merge step with `agentId: integrator`.
2. The integrator works in the feature worktree and calls
   `kanban_feature` with `action: "merge"`.
3. The board merges `kanban/feature-F` into the project branch.
4. The feature state becomes `done`. The merge note says what was merged.

**Result**: the project branch holds the feature. The board never merges a
feature by itself.

### UC-5 — the merge conflicts

**Actor**: `integrator`

1. The integrator calls `kanban_feature` with `action: "merge"`.
2. Git reports a conflict. The board aborts the merge, so the project branch
   stays clean.
3. The feature keeps `mergeNote` with the conflicting files and stays
   `active`.
4. The integrator resolves the conflict in the feature worktree, commits, and
   merges again.

**Result**: no silent overwrite. The conflict is visible on the board.

**The same happens in the per-task mode.** When the merge of a task branch
fails, the task keeps its status `done`, but `worktreeState` becomes
`conflict` and the note names the files. The branch and the worktree are kept,
so the work is not lost. The board assistant reports the conflict and retries
with `kanban_worktree` and `action: "merge"`.

### UC-6 — the board manager reports the result

**Actor**: `board-manager`

1. A task ends `done`.
2. The board queues a link-back message into the parent session.
3. The message holds the result, the blocker, the worktree branch, the
   worktree state, the worktree folder and the merge note.

**Result**: the board manager can report where the work is and whether it
reached the project branch.

### UC-7 — a delegated agent delegates further

**Actor**: `coding-orchestrator`

1. The orchestrator calls `kanban_delegate` with `agentId: coder`.
2. The board creates the task with `parentSessionId` = the orchestrator
   session, and its own worktree.
3. The coder works, commits and ends `done`.
4. The board queues the result into the orchestrator session.

**Note**: the nested delegate uses `wait: false`. A nested `wait: true` keeps
the parent session busy for the whole run and is not needed.

## Rules for the agents

- Work only inside the worktree of the task. The session starts there.
- Commit the work on the branch of the task. Uncommitted work is not merged.
- Do not merge, do not push, do not switch branches.
- In a feature worktree: do not reset, clean or delete the folder. The work of
  the earlier steps is in it.
- In a feature worktree: one step at a time. The board refuses a second
  running step of the same feature.
- Only the `integrator` triggers a feature merge, and only into the project
  branch.

**What is enforced and what is not**

| Rule | Enforced by |
|---|---|
| a task runs in its own worktree | the board (session directory) |
| a feature task runs in the feature worktree | the board (session directory) |
| one running step per feature | the board (refuses the second start) |
| the work is committed on the branch | the merge (uncommitted work is not merged) |
| no merge, no push, no branch switch | **a prompt rule only** |
| no write outside the worktree | **a prompt rule only** |

The last two are prompt rules. The session starts in the worktree, but an
agent can still write to any folder with an absolute path. The board cannot
stop that. Give the agent no reason to leave its folder, and check the diff
in the review step.

## The merge guard

Before the board merges a branch into the project branch, it checks two things.

**1. The commit gate — the work must be committed.**

```
git -C <worktree> status --porcelain
```

If the worktree has uncommitted changes, the merge is **refused**:

> *"the work is not committed yet: 3 file(s) changed in the worktree. The agent
> must commit before the merge."*

The task keeps its worktree and its work. The card shows the reason. Without
this gate the card would say `done` while part of the result was still in the
folder.

**2. The base guard — has the project branch moved?**

```
git merge-base --is-ancestor main <feature branch>
```

- **exit 0** — the feature branch contains the current `main`. Nothing moved
  since the last sync. The merge lands.
- **exit 1** — `main` moved after the last sync. The board **rebases** the
  feature branch onto `main` first, then merges. A rebase that conflicts is
  aborted and reported: the agent resolves it in the worktree and the board
  retries.

So a branch that reaches the project branch always contains the current
`main`. The checks (verification, review) that ran before the sync are then
valid for the result that lands.

**The sync, on demand**

```
python server/kanban.py worktree sync <taskId>
POST /api/kanban/tasks/:id/worktree/sync
kanban_worktree { action: "sync", taskId }
```

The orchestrator calls it after the implementation step and before the
verification step, so the tests run against the current code.

## The board does the git work

The board owns the git flow of a feature (option A). It never opens a pull
request; it merges into the local project branch and pushes it.

**Before the worktree is cut** — the base branch is brought up to date:

```
git -C <repo> pull --ff-only origin main
```

A worktree that starts from an old base makes every later merge a conflict.
The pull is best effort: a failed pull (no remote, dirty tree, no network)
does not stop the work. The note says what happened.

**After the merge** — the project branch goes to the remote:

```
git -C <repo> push origin main
```

A failed push does **not** undo the merge. The work is merged locally; the
merge note says that the push must be repeated:

> *"Merged kanban/feature-fc93ad7a into main (not pushed: no remote)"*

The result of a merge carries the two fields `pushed` (true/false) and
`pushNote` (the reason). A repo without a remote is normal: the merge works
and the note says "no remote".

## A merged feature goes to the archive

A feature that is merged is finished work. The board moves it out of the
daily view:

| What | When it moves to the archive |
|---|---|
| every **done** step of the feature | the merge succeeds |
| the **merge step** itself | it ends after the merge |
| the **owner** of the feature (the orchestrator) | it ends after the merge |

The rule lives in the board, not in the agent. The orchestrator never changes
a status; it only reports that the feature is merged.

A task in the archive keeps its result, its history and its worktree state.
The board does not start it, does not watch it and does not deliver its
result again.

## The agent team belongs to the board

The team (board manager, coding orchestrator, planner, coder, testing,
reviewer, integrator) lives in **one** place: the board's own
`.opencode/agents/` folder.

```
C:\work\kanban\.opencode\agents\        ← the source of truth
        │  kanban.py team install
        ▼
C:\Users\rober\.config\opencode\agents\ ← global OpenCode agents
        │
        ├── every session in every folder sees the current team
        └── every worktree gets a copy (invisible to git)
```

- `python server/kanban.py team install` installs the team as **global**
  OpenCode agents. The dev script runs it at every start.
- A **project repo does not need a copy**. The team is board configuration, not
  project code. A project may still hold its own agents; they win over the
  global ones for the same id.
- A worktree still gets a copy of the files, so the team is visible there and
  the worktree is self-contained. The files are invisible to git (skip-worktree
  plus a per-worktree exclude file), so they never enter a commit.
- The source folder can be changed with `KANBAN_AGENT_TEAM_DIR`.

## Merge details

- The merge is a plain `git merge --no-edit <branch>` in the main checkout.
  It is a merge commit when the branch has commits of its own, and a
  fast-forward when the project branch has not moved.
- The target is the **project branch** (`projects.gitBranch`, `main` in this
  setup). The board refuses to merge when the main checkout stands on another
  branch, and it names the branch in the error.
- A **merge lock** (a lock file in the worktree root) protects the main
  checkout: two merges at the same time would fight over `.git/index.lock`.
- The main checkout may hold uncommitted work. Git then refuses the merge
  when the merge would touch those files. The board names the uncommitted
  files in the error, so the reason is clear.
- After a successful merge of a task, the board removes the worktree folder
  when it is clean, and deletes the branch. A worktree with uncommitted work
  is kept, and the note says so.
- A feature worktree is removed when the feature is deleted
  (`kanban_feature` with `action: "delete"`). On Windows the folder is often
  still locked by a running session. The board keeps it and reports the
  error. Remove it later by hand or with `git worktree remove --force`.

## Where the worktrees live

- Default: `<KANBAN_PROJECTS_ROOT>/.kanban-worktrees/<project>/<id>`. This is
  **outside** the repository, so no `git status` noise.
- With `KANBAN_WORKTREES_ROOT` the root can be anywhere. When it points
  inside a repository, add `.kanban-worktrees/` to that `.gitignore`.
- The folder of a feature is `.../<project>/feature-<featureId>`.

## Setup files in a fresh worktree

A new worktree has the **committed** files only. It has no `.env`, no
`node_modules` and no build output.

- The board copies `.env` and `.env.local` into the new worktree. The steps
  can therefore read the configuration.
- `node_modules` is **not** copied. The verification step installs it
  (`npm ci`) or links it, before it runs the tests. Put this step in the
  brief of the verification task.
- The uncommitted changes of the main checkout are **not** in the worktree.
  Commit them first, or copy them into the worktree by hand.

**Never delete a worktree folder with `rmdir /s /q`.** A worktree can hold a
`node_modules` **junction** to the main checkout. On Windows `rmdir /s`
walks through a junction and deletes the files of the target: the
`node_modules` of the main project is gone. The board removes a leftover
folder with `safe_rmtree`, which takes a junction as a link and never enters
it.

## Surface

**Plugin tools**

| Tool | Actions |
|---|---|
| `kanban_worktree` | `create`, `sync`, `merge`, `remove`, `list` - the worktree of a task |
| `kanban_feature` | `create`, `show`, `list`, `merge`, `delete` - the worktree of a feature |
| `kanban_delegate` | takes `featureId`, so a step runs in the feature worktree |
| `kanban_heartbeat` | the progress of a running task ("waiting: the verification step") |

**HTTP**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/kanban/tasks/:id/worktree` | `{ taskId, path, branch, state, note }` |
| POST | `/api/kanban/tasks/:id/worktree` | create the worktree of a task |
| POST | `/api/kanban/tasks/:id/worktree/merge` | merge the task branch into the project branch |
| DELETE | `/api/kanban/tasks/:id/worktree` | remove the worktree folder |
| GET | `/api/kanban/features?projectId=` | features of a board |
| GET | `/api/kanban/features/:id` | feature with its tasks |
| POST | `/api/kanban/features` | create a feature: worktree + branch |
| POST | `/api/kanban/features/:id/merge` | merge the feature branch into the project branch |
| DELETE | `/api/kanban/features/:id` | delete the feature and its worktree |

**CLI**

```
python server/kanban.py worktree create <taskId>
python server/kanban.py worktree merge  <taskId>
python server/kanban.py worktree remove <taskId>
python server/kanban.py worktree list
python server/kanban.py feature  create --project <id> --title "Feature A"
python server/kanban.py feature  list|show|merge|delete
```

## Tests

| Area | File | Cases |
|---|---|---|
| per-task worktree | `server/kanban-worktree.test.mjs` | 12: the folder and the branch, two tasks get two folders, create is idempotent, work in a worktree does not touch the main repo, `done` merges, uncommitted work is kept, a conflict is reported, the list, remove, a re-run starts fresh, a project without git fails |
| feature worktree | `server/kanban-feature.test.mjs` | 11: one folder and one branch, the task carries the location, the board does not merge, `feature merge` puts the branch in, unknown and foreign features are rejected, delete clears the link and the folder, a conflict is reported, one running step per feature, the delegation chain |
| link-back message | `scripts/linkback.test.mjs` | 3 new: the worktree block, a conflict is marked as not merged, no worktree lines without a worktree |
| nested delegation | live | the board part is covered by the feature chain test; the agent part was proven live (assistant → orchestrator → coder, each with its own worktree) |

**Not covered by a test**: the agent behaviour inside the worktree (that it
really commits and never touches the main folder). That is a prompt rule, and
the review step is the check.

## What changed in the code

| File | Change |
|---|---|
| `server/kanban.py` | `features` table, `tasks.feature_id`, `worktree` CLI group, `feature` CLI group, automatic merge of a task on `done`, merge lock, worktree reset, one running step per feature, copy of `.env` |
| `server/kanban-worktree.test.mjs` | 12 tests for the per-task worktree |
| `server/kanban-feature.test.mjs` | 11 tests for the feature worktree |
| `opencode-plugin/core.js` | the board CLI runs **asynchronously** (a plugin must not block the server) |
| `opencode-plugin/delegate.js` | the delegate creates the worktree and starts the session in it; a feature step uses the feature worktree; the prompt states the worktree rules |
| `opencode-plugin/index.ts` | the tools `kanban_worktree`, `kanban_feature` and `kanban_heartbeat`; `kanban_delegate` takes `featureId` |
| `scripts/linkback.mjs` | the link-back message carries the worktree block |
| `vite.config.js` | the HTTP delegate and the task start use the worktree; the routes for tasks and features |
| `src/App.tsx`, `src/mobile/useBoardData.ts` | a task start creates the worktree and moves an old session into it; a failed move is reported |
| `src/store/kanban.ts` | `createTaskWorktree`, `getTaskWorktree`, `mergeTaskWorktree`, `removeTaskWorktree` |
| `src/components/TaskModal.tsx` | shows branch, state, folder and note, with **Merge now** and **Remove worktree** |
| `src/prompts/taskPrompt.ts` | the task contract states the worktree folder, the branch and the rules |
| `.opencode/agents/*.md` | the agent definitions: the new `coding-orchestrator`, and the worktree and feature rules for every role |
| `prompts/*.md` | the rules for the agents and the board manager |

## Limits

- A worktree starts from the **last commit** of the project branch. The
  uncommitted changes of the main checkout are not in it.
- A fresh worktree has no `node_modules`. The verification step installs it.
- The steps of a feature run one after the other. Parallel steps need the
  per-task mode.
- On Windows a worktree folder often stays locked by the running session. The
  board keeps it and says so.
- The rules "no merge", "no push" and "no write outside the worktree" are
  prompt rules, not board rules.
- The board refuses a second running step of a feature, but it cannot stop an
  agent from writing outside its folder.

## See also

- `vmodel/feature-worktree-orchestration/concept-design.md` — the design of
  the feature mode.
- `docs/KANBAN_API.md` — the worktree and feature routes.
- `.opencode/agents/README.md` — the team workflow and the git rules.
