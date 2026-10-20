# Concept and Design — Feature Worktree Orchestration

> Extends the per-task worktree model (`server/kanban.py worktree *`). That
> model gives **every task** its own folder and branch. This one adds a
> **feature**: a group of tasks that share **one** worktree and **one** branch,
> so the steps of one unit of work build on each other.

## Problem

The board runs one task at a time in its own worktree. That is right for
parallel work, but a real unit of work is not one task. A feature is normally
split into steps:

```
concept → implementation → verification → review → merge
```

With one worktree per task, each step is isolated, and each step pays a full
merge into the project branch. The next step then starts from the project
branch — so it sees the previous step only because that step was merged and the
merge succeeded. If two steps touch the same file, the second merge conflicts
and the board reports it, even though the steps never ran at the same time.

The team is also missing a level. Today the board manager (the user interface)
delegates straight to the implementer. Nobody owns the feature: nobody creates
the shared workspace, nobody sequences the steps, nobody merges the feature at
the end.

## Goals

1. **The board manager is the product owner.** It clarifies the request, splits
   it into a feature and its steps, forwards the feature to the coding
   orchestrator, and reports the result. It writes no code.
2. **The coding orchestrator owns the feature.** It creates **one** worktree
   and **one** branch for the feature, plans the steps, delegates them **one
   after the other**, reviews every result, and asks for the merge.
3. **All steps of a feature work in the same folder and on the same branch.**
   Each step sees the files of the previous step directly. No cherry-pick, no
   copy, no merge between the steps of one feature.
4. **The feature branch is merged by the `integrator` agent, always into the
   main branch.** The board never merges a feature on its own. The integrator
   gets its own task, works in the feature worktree, and triggers the merge.
5. **Every task carries the worktree location.** A task row of a feature points
   to the feature worktree and the feature branch, so the board, the prompts
   and the agents always know where the work happens.
6. **Tasks without a feature keep the current behaviour** (own worktree, own
   branch, own merge). The two modes live side by side.

## Non-Goals

- **No parallel steps inside one feature.** One folder means one writer. The
  steps of a feature run in sequence. Parallel work stays on the per-task
  worktree mode.
- **The board never merges a feature by itself.** The merge is a task for the
  `integrator` agent. The board only offers the git operation
  (`kanban_feature merge`); the agent decides when to use it and reports the
  result.
- **No GitHub automation.** Opening the pull request and merging it stays with
  the `integrator` agent.
- **No new status values.** A feature uses `active` / `done`; the tasks keep
  `backlog|running|done|blocked`.
- **No nested features.** A feature belongs to one project and has one branch.

## Who does what

The roles already exist in `.opencode/agents/`. The feature flow uses them in
this order:

| Level | Agent | Work | Ends with |
|---|---|---|---|
| 0 | user → `board-manager` | clarify, split into feature + steps, forward, report | one answer for the user |
| 1 | `coding-orchestrator` (new) | create the feature (worktree + branch), plan the steps, delegate them in order, review each result, delegate the merge | feature merged or blocked with a reason |
| 2 | `planner` | **concept**: goal, scope, affected files, acceptance criteria, risks, checks | plan committed in the feature worktree |
| 2 | `coder` | **implementation**: the change | code committed, build and tests pass |
| 2 | `testing` | **verification**: writes and runs the tests, reports reproducible output | test results reported |
| 2 | `reviewer` | **review**: checks the complete diff, blocks unsafe work | no open finding |
| 2 | `integrator` | **merge**: merges the feature branch into **main**, opens the pull request when the project uses GitHub | main holds the feature |

Level 2 steps are tasks of the feature. They all run in the feature worktree.
The **integrator is the last step**: it is a task like the others, it works in
the same folder, and it is the only one that merges.

Model routing follows `.opencode/agents/README.md`: Luna for simple, bounded
steps; Sol for complex reasoning; a cheap local model for verification. The
model is a field on the task, so every step can use a different one.

## Two worktree modes

| | Per-task worktree (today) | Feature worktree (new) |
|---|---|---|
| Trigger | a task with no feature | a task with a feature |
| Folder | `<root>/<project>/<taskId>` | `<root>/<project>/feature-<featureId>` |
| Branch | `kanban/task-<taskId>` | `kanban/feature-<featureId>` |
| Merge | when the task is done | by the `integrator` task, into **main** |
| Parallel steps | yes | **no** — one writer per folder |
| Result per step | its own merge note | the shared feature merge state |

A task that belongs to a feature never merges on its own. Only the integrator
step merges, and only into the main branch.

## The worktree location on the task

Every task row carries where its work happens:

| Field | Per-task mode | Feature mode |
|---|---|---|
| `worktreePath` | the task's own folder | **the feature folder** |
| `worktreeBranch` | `kanban/task-<id>` | **`kanban/feature-<id>`** |
| `worktreeState` | `active` / `merged` / … | the **feature** merge state |

The board shows it on the card, the agent prompt states it, and the link-back
message reports it. The orchestrator therefore always knows that all steps of
its feature work in one folder, and the user always sees where the work is.

A feature task does not create a worktree of its own. The worktree is created
**once**, by the orchestrator, when the feature is created.

## Data Model

`server/kanban.py`:

- New table `features`:

  | Column | Meaning |
  |---|---|
  | `id` | uuid |
  | `project_id` | the board |
  | `title`, `description` | what the feature is |
  | `status` | `active` / `done` |
  | `worktree_path`, `worktree_branch` | the shared folder and branch |
  | `base_branch` | the branch the feature started from |
  | `merge_note` | last merge message (conflict details) |
  | `created_at`, `updated_at` | |

- New column `tasks.feature_id` — the feature a task belongs to. `NULL` keeps
  the per-task worktree mode.
- `row_to_task()` returns `featureId`; `row_to_feature()` returns the feature
  with its task ids.

**Source of truth**: the `features` row owns the worktree path and the branch
of a feature. A task row of a feature holds a **copy** of both, written when
the task is created, so the board can show the location without a join. The
copy cannot drift: the worktree of a feature never changes after the feature
is created. Deleting the feature clears the copy on its tasks.

## The life of a feature

```
1. board-manager      → kanban_delegate                    to the coding-orchestrator
2. coding-orchestrator→ kanban_feature create               → worktree + branch kanban/feature-xxxx
3. coding-orchestrator→ kanban_delegate(concept task)       → featureId, blockedBy []
4. coding-orchestrator→ kanban_delegate(implementation task)→ featureId, blockedBy [concept]
5. coding-orchestrator→ kanban_delegate(verification task)  → featureId, blockedBy [implementation]
6. coding-orchestrator→ kanban_delegate(review task)        → featureId, blockedBy [verification]
7. coding-orchestrator→ kanban_delegate(merge task)         → featureId, blockedBy [review], agent = integrator
8. integrator         → kanban_feature merge                → the feature branch goes into main
9. coding-orchestrator→ reports to the board manager        → the user gets one answer
```

**Step 2 — the orchestrator creates the worktree**

The orchestrator creates the feature before it delegates the first step. One
folder, one branch, for all steps. Every task of the feature then points at
that folder (`worktreePath`) and that branch (`worktreeBranch`).

**Step 3–6 in detail**

- The delegated task runs with `location.directory = <feature worktree>`. The
  session works in the shared folder.
- The task commits on the **feature branch**. It does not create a branch, does
  not merge, does not push, does not switch branches.
- The next step starts only after the previous one is `done`
  (`blockedByTaskIds`), so the folder has one writer at a time.
- The result of every step is delivered to the orchestrator's session by the
  board (the link-back message), together with the feature merge state.

**Step 7–8 — the merge is a task**

- The merge is a **delegated task** for the `integrator` agent. It is the last
  step of the feature, blocked by the review step.
- The integrator works in the feature worktree and calls
  `kanban_feature merge`. The board does the git work in the main checkout:
  it merges the feature branch into **main** (the pinned project branch).
- The target is always main. The integrator never merges into another branch
  and never pushes without the project's push rules.
- When the project uses GitHub, the integrator opens the pull request first and
  merges it after the checks pass — the board merge stays the local fallback.
- A conflict stops the merge. The feature keeps `mergeNote` with the conflict
  and stays `active`. The integrator resolves it in the feature worktree and
  calls `kanban_feature merge` again.

## Rules for the agents in a feature worktree

- Change only files inside the feature worktree.
- Commit on the feature branch. Uncommitted work is not merged.
- Do **not** merge, do **not** push, do **not** switch branches.
- Do **not** reset, clean or delete the folder — the work of the earlier steps
  is in it.
- Do **not** start a second step in parallel. One folder, one writer.
- Report the changed files and the verification in the final message.

## Interface

**Plugin tool `kanban_feature`** (done):

| Action | Meaning |
|---|---|
| `create` | create the feature: worktree + branch |
| `show` | feature, its tasks, merge state |
| `list` | features of a board |
| `merge` | merge the feature branch into the **project branch** (the integrator calls this) |
| `delete` | delete the feature and its worktree |

**`kanban_delegate`** gains an optional `featureId`. With it, the task runs in
the feature worktree instead of a new one.

**HTTP** (new):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/kanban/features?projectId=` | features of a board |
| `GET` | `/api/kanban/features/:id` | feature with its tasks |
| `POST` | `/api/kanban/features` | create a feature |
| `POST` | `/api/kanban/features/:id/merge` | merge the feature branch |
| `DELETE` | `/api/kanban/features/:id` | delete the feature |

**CLI** (new): `feature create|list|show|merge|delete`.

**UI** (new): a feature badge on the task card (feature title, branch, merge
state) and a small feature list in the project settings.

## Error Handling & Edge Cases

- **Task with an unknown feature**: the delegate fails with the feature id, the
  task is not created.
- **Feature in another project**: rejected, same rule as dependencies.
- **A second step of the same feature starts**: the board **refuses** it
  ("Feature worktree is busy"). One folder, one writer. This is enforced by
  the board, not by a prompt rule.
- **Feature worktree folder deleted by hand**: the next step that starts gets a
  fresh folder and branch (same rule as the per-task worktree reset).
- **A step fails and is retried**: the folder keeps the failed state. The
  orchestrator decides: fix in place, or delete the feature and start over.
- **The merge task fails** (conflict, dirty main checkout, wrong branch): the
  integrator reports the exact reason, the feature stays `active`, and the
  merge can be repeated after the cause is fixed. The board names the
  uncommitted files of the main checkout in the error.
- **The feature is deleted**: the worktree folder and the branch are removed,
  the tasks stay on the board and lose the feature link. They fall back to the
  per-task worktree mode.
- **Two steps run in parallel by mistake**: the board refuses the second one.
  If an agent writes to the folder anyway, the work is lost — the board cannot
  stop that.
- **The feature branch was merged by hand**: the board merge reports
  "Already up to date" and marks the feature `done`.

## Setup files in a fresh worktree

A new worktree holds the **committed** files only: no `.env`, no
`node_modules`, no build output.

- The board copies `.env` and `.env.local` into the new worktree.
- `node_modules` is not copied. The verification step installs it (`npm ci`)
  before it runs the tests. The orchestrator puts this in the brief.
- The uncommitted changes of the main checkout are not in the worktree.

## Testing plan

- Server: create a feature → it has a folder and a branch; a task with
  `feature_id` uses that folder and carries it in `worktree_path`; the feature
  branch is **not** merged when a task ends done; `feature merge` merges it into
  main; a conflict is reported and not applied; a feature without git fails with
  a clear error.
- Plugin: `kanban_feature` actions; `kanban_delegate` with `featureId` uses the
  feature folder; the prompt tells the agent the shared-folder rules and that
  only the integrator merges.
- Live: board manager → orchestrator → planner/coder/testing/review in one
  folder, one commit chain, then the integrator task merges the feature branch
  into main.

## Open Questions

- Should a feature be visible as its own card on the board, or only as a badge
  on its tasks? A card gives the orchestrator one place to see the state, but
  adds a third board concept next to projects and tasks.
- Should the board start the next step of a feature automatically when the
  previous one is done? Today the orchestrator starts it (it gets the result
  notification and calls `kanban_start_task`). Automatic start is simpler for
  the orchestrator but removes its control over the order.
- Should the feature worktree be deleted after the merge, even when a session
  still lives in it? The session would lose its working folder.
- Should the merge task be the last step of the feature, or a separate task
  outside the feature? Inside the feature keeps one worktree and one board
  group; outside it makes the merge a top-level job.

## Implementation status

The concept is written first. The server part is done and tested:

- `features` table, `tasks.feature_id`, backfill in `get_conn()`.
- `feature create|list|show|merge|delete` CLI.
- `task create --feature <id>`: the task row carries the feature worktree path
  and branch from the start.
- The board does **not** merge a feature when a task ends `done`. The merge
  runs only when the integrator calls `feature merge` (into the project
  branch, main).
- The board refuses a second running step of the same feature.
- The board copies `.env` into a new worktree.
- Tests: `server/kanban-feature.test.mjs` — 11 cases.

The plugin and the HTTP part are done:

- The tool `kanban_feature` (create, show, list, merge, delete).
- `kanban_delegate` takes `featureId`: the step runs in the feature worktree
  and the prompt states the shared-folder rules.
- The routes `/api/kanban/features` and `/api/kanban/tasks/:id/worktree`.

The agent definitions are done:

- `.opencode/agents/coding-orchestrator.md` — the feature owner.
- `.opencode/agents/board-manager.md` — the product owner; forwards a feature
  request to the orchestrator.
- `planner`, `coder`, `testing`, `reviewer`, `integrator`, `general-task` —
  the worktree rules, the feature rules and the completion markers.

Still to build:

1. The UI: a feature badge on the task card and a feature list in the project
   settings. The board shows the worktree of a task today.
2. A live test of the whole chain with the real agents: board manager →
   orchestrator → planner/coder/testing/reviewer → integrator.
