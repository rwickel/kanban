# Board manager — the interface between the user and the agent team

## Goal

The user talks to one agent: the **board manager**.
The manager takes the user request and uses the agent team.

There is **one request type**. The user writes what it wants. The manager **sizes the work** and makes a plan of the right size:

- small work → one feature, one group of steps
- large work → many features, one after the other

The manager states the size in the proposal. The user can correct it.

The manager works for a long time. The user watches the board. The user can stop it at any time.

The manager never starts work without the user's approval. It proposes first.

## Roles

| Role | What it does |
|---|---|
| User | Writes the request. Reviews the proposal. Approves it. Watches the board. Stops the work. |
| Board manager | Proposes, delegates, checks, merges, repeats. It does not write the app code itself. |
| Feature orchestrator | One session that owns one feature: it creates the feature worktree, delegates the 5 steps, checks the results. |
| Team | planner, coder, tester, reviewer, integrator (the project team). |

The manager is the only agent that talks to the user. The team never talks to the user.

**The feature orchestrator is not a new team agent.** It is a delegated task with the feature-orchestrator prompt. It has its own session. The board manager creates one per approved feature. The team members (planner, coder, tester, reviewer, integrator) stay the same.

## The manager is a board task

The manager must be a **task row with a session**. It must not be only a chat.

Reasons:

- The user sees the manager on the board: card, status, progress note.
- The user can stop the manager: stop the task = stop the session.
- All proposal items and step tasks become children of the manager task. The server sets this link by itself (`parentTaskId`, see the task-to-task link).
- The results of the steps come back into the manager session.

## The full flow

```
user request
   ↓
manager analyzes and sizes the work
   ├─ open questions → manager writes the open questions
   │                    ↓
   │              user answers the questions (or takes the defaults)
   │                    ↓
   │              manager continues
   ↓
manager proposes  (writes the proposal with the size, starts no work)
   ↓
user reviews
   ├─ accept          → manager starts the accepted work
   ├─ accept part     → manager starts the accepted items only
   ├─ edit an item    → manager corrects that item and shows the proposal again
   ├─ correct the size→ manager re-sizes the work and shows the proposal again
   └─ request changes → manager writes a new proposal version → user reviews again
   ↓
manager executes the accepted plan
   │   (a step can raise new open questions → the manager asks and waits)
   ↓
goal done
```

## Open questions

The manager must not guess. If the request is not clear, the manager asks.

An **open question** is a question the manager writes on the board. The user answers it in the goal panel. The answer comes back into the manager session.

### When the manager asks

| Moment | Example |
|---|---|
| Before the proposal | "Which database do you want: SQLite or Postgres?" |
| During the plan | "Should the login work with a local user or with the company SSO?" |
| During the work | "The test needs a real key. Which test key may the agent use?" |

### Rules for the manager

- The manager asks only what it cannot decide alone.
- The manager asks **at most 3 questions at a time**. A long list of questions stops the work.
- Every question has a **default**. The user can accept the default with one click.
- A question that does not block the start is not asked. The manager states the assumption in the proposal and continues.
- The manager waits for the answer. It does not poll.
- After the answers, the manager writes the **final proposal**. The user reviews it as usual.
- A question during the work pauses the work. The manager sets the goal to `waiting`.

### What a question holds

| Field | Content |
|---|---|
| question | The question text |
| why | Why the manager asks (one line) |
| options | Optional list of choices |
| default | The default answer |
| answer | The answer of the user |
| state | open, answered, skipped |
| item | Optional: the proposal item or step it belongs to |

### The user can

- answer a question in the goal panel,
- take the default,
- skip a question (the manager uses the default and says so),
- stop the goal.

## The proposal

### What the proposal is

A list of items on the board. The user sees it in the goal panel.

| Item | Content |
|---|---|
| title | Short name of the work |
| description | What the agent must do |
| acceptance criteria | How the user checks the result |
| agent | The team member that must do it |
| order | Position in the plan |
| wave | The wave of the item. The items of one wave run in parallel. |
| area | The file area of the project the item touches. Two items with the same area never run in parallel. |
| state | proposed, accepted, rejected, changed |

The proposal has a head:

| Head | Content |
|---|---|
| size | small, medium, large (the manager sizes the work) |
| estimate | number of features, number of steps, rough time |
| why | why the manager chose this size |
| version | the number of the proposal version |

The proposal shows the **next level of work**:

- small or medium work → the proposal shows the steps of the one feature.
- large work → the proposal shows the list of features. The steps of a feature are made when the feature starts. The user can ask for a deeper plan before it starts.

The proposal shows the **waves**. The items of one wave run in parallel. The user sees which work runs at the same time.

### Rules for the manager

- The manager writes the proposal and stops. It waits for the user.
- The manager reads the project before it proposes. It does not change any file before the approval.
- The manager starts no work before the approval: no feature worktree, no delegated task, no branch.
- The manager shows the proposal again after every change. The user always sees the current version.
- New work needs a new proposal. The manager does not add items after the approval without asking.
- The manager keeps the acceptance criteria of every item. It uses them later to check the result.
- If the request is not clear, the manager asks open questions. It does not guess.
- The manager states the size of the work. It does not ask the user for the type.

### What the user can do

| Action | Result |
|---|---|
| Accept all | All proposed items become work. The manager starts. |
| Accept one item | Only that item becomes work. The other items stay proposed. |
| Reject one item | The item is dropped. The manager does not do it. |
| Edit an item | The user changes title, description, criteria, agent or order. The manager reads the change. |
| Correct the size | The user says "this is small" or "this is an app". The manager re-sizes the work and shows the proposal again. |
| Request changes | The user writes free text. The manager writes a new proposal version. |
| Stop | The manager stops. The plan stays on the board. |

If the user rejects an item that another item depends on, the board shows a warning. The manager must fix the chain before it starts.

## One request. The manager sizes the work

The user does not choose a request type. The manager reads the request, reads the project, and estimates the work.

| Size | What the manager makes | What the proposal shows |
|---|---|---|
| small — one clear change | one feature | the 5 steps of the feature |
| medium — a feature with parts | one feature, more steps | the steps of the feature |
| large — a whole app or a big area | many features | the list of features |

The size is part of the proposal:

| Field | Content |
|---|---|
| size | small, medium, large |
| estimate | number of features, number of steps, rough time |
| why | why the manager chose this size |

### Rules for the sizing

- The manager sizes the work from the request and the project. It does not ask the user for the type.
- The manager states the size and the reason in the proposal. The user sees it before the work starts.
- The user can **correct the size**. The manager re-sizes the work and shows the proposal again.
- The manager may raise the size during the work (the request was bigger than it looked). It makes a new proposal and asks.
- The manager may lower the size. The same rule applies.

### The steps of one feature

Every feature, small or large, uses the same 5 steps:

```
concept        (planner)
implementation (coder)
verification   (tester)
review         (reviewer)
merge          (integrator)
```

The steps are a chain. Each step waits for the step before it (`blockedByTaskIds`).
A feature is done when the merge step is done and the acceptance criteria pass.

### The work of a large request

1. **Understand.** Read the project. Write the plan with a list of features.
2. **Ask.** If the request is not clear, write open questions. Stop. Wait for the answers.
3. **Propose.** Write the proposal with the size. Stop. Wait for the user.
4. **Start.** After the approval, run the work in waves. The manager starts all items of wave 1 at the same time.
5. **App check.** After the last wave, a tester agent checks the whole app.
6. **Finish.** Write the final result. Set the manager task to `done`.

The plan must survive a restart. It must not live only in the chat. It is stored on the goal row.

## Parallel work — many feature orchestrator sessions

The goal runs **one board manager** and **one feature orchestrator session per feature**. The feature orchestrators work in parallel.

```
Goal task (board manager, kind=goal)
 ├─ feature orchestrator A  (session 1)  → own feature worktree + branch
 │   └─ step: concept, implementation, verification, review, merge
 ├─ feature orchestrator B  (session 2)  → own feature worktree + branch
 │   └─ step: concept, implementation, verification, review, merge
 └─ feature orchestrator C  (session 3)  → own feature worktree + branch
     └─ step: concept, implementation, verification, review, merge
```

- The **board manager** plans, proposes, gets the approval, and starts the feature orchestrators. It does not write code.
- Each **feature orchestrator** runs the 5 steps of its own feature. It owns its feature worktree and its branch. It has its own session.
- The feature orchestrators are children of the goal task. The `parentTaskId` link makes the tree visible on the board.
- The steps of one feature are a chain (one writer per worktree). The features run in parallel.

### Rules

- The board manager starts all approved features at the same time. The features that depend on each other wait (`blockedByTaskIds`).
- Two features may run in parallel only if they touch **different file areas**. The board manager writes the area of every feature into the proposal. The user sees it.
- If the board manager is not sure about the areas, it runs the features one after the other.
- Every feature orchestrator has its **own worktree and branch**. The files never fight.
- The **code runs in parallel. The merges run one after the other.** The server has a merge lock per repository. The board manager checks every merge and starts a repair task for a conflict.
- The board manager waits for the results of the feature orchestrators. The board sends every finished result into the manager session (no polling).

### The board

- The goal card shows the feature orchestrators as its subtasks. The user sees the tree.
- The card of a feature orchestrator shows its step: `feature B — verification`.
- The card of the manager shows the count: `3 features running, 1 merged`.

### What the board needs

| Change | Why |
|---|---|
| A `role` on the task: `manager` or `feature` | The board must know which kind of session a task has |
| A kind `goal` (or a role field) | The goal task must not be auto-finished by the reconciler |
| The merge lock must fail, not run unlocked | Today the lock waits 5 s and then the merge runs anyway. Two parallel merges can then touch one repo |
| The board manager must be able to start many feature orchestrators | `kanban_delegate` with `wait=false` does this already |
| The result of a feature orchestrator comes back to the manager | The result link-back does this already (the manager session is the parent session) |

## The manager loop (execution)

The **board manager** loop:

```
propose → approval → start all approved features (parallel) → wait for the results → check → finish
```

Inside one **feature orchestrator** the order is always:

```
CONCEPT → IMPLEMENT → VERIFY → REVIEW → MERGE
```

Rules for every agent:

- The board manager starts all approved features at the same time. It uses `wait=false` for every feature orchestrator.
- Inside one feature orchestrator: one step at a time. One worktree has one writer.
- Nobody sleeps and nobody polls. Every agent ends its turn. The board queues the result of the finished task into the parent session and wakes it.
- Every agent sends one heartbeat before it waits. The note shows on its card.
- Every agent checks the acceptance criteria of the step against the result of the step.
- If a step is not accepted: the agent creates one repair task. Maximum 3 tries per step.
- If a step finds an open question, the agent writes the question, sets the goal to `waiting`, and ends the turn. The work continues after the answer.

## Board data (the tree)

```
Goal task (board manager, kind=goal, role=manager, goal_status=proposed)
 ├─ open question: "Which database?"     state=open
 ├─ proposal item: feature A              status=proposed  area=src/api
 ├─ proposal item: feature B              status=proposed  area=src/web
 ├─ feature orchestrator A                status=running   role=feature  featureId=A
 │   └─ step: concept                     status=done      featureId=A
 │       step: implementation             status=running   featureId=A  blockedBy=concept
 │       step: verification               status=backlog   featureId=A  blockedBy=implementation
 └─ feature orchestrator B                status=running   role=feature  featureId=B
     └─ step: concept                     status=running   featureId=B
```

- The proposal items are task rows with the status `proposed`. The normal board columns do not show them. The goal panel shows them.
- An accepted item changes to `backlog`. It is real work now.
- The open questions are rows of the goal. They are not tasks. They are shown in the goal panel.
- The feature orchestrators and the stage tasks get `parentTaskId` = the task of their parent session. This is automatic. The link makes the tree visible.
- The board shows the goal card and the new "Subtasks" block with all items.
- Small work has no feature orchestrator. The board manager runs the 5 steps of the one feature itself.

## Stop rules

The manager stops in these cases:

| Case | Action |
|---|---|
| All accepted features are merged and the app criteria pass | Write the result. Set the task to `done`. |
| A step fails 3 times | Set the task to `blocked`. Write what failed. Ask the user. |
| The project tests fail after a merge | Open one repair feature. Then continue. |
| A merge of a feature has a conflict | Make one repair task for the conflict. Then continue. |
| The request is not clear enough | Write open questions. Set the goal to `waiting`. Do not start. |
| The user rejects everything | Write the result. Set the task to `done` with the reason "nothing accepted". |
| The user stops the task | The session stops. The manager stops. |
| A budget limit is reached | Set the task to `blocked`. Write the state. |
| An open question stays unanswered for a long time | Wait. The user can stop the goal. No auto answer. |

## Long run rules

- The goal task uses a new kind `goal` (or `kind=service` + role `manager`). The stall watchdog does not block services. A `oneshot` task is blocked after 600 s without a heartbeat.
- The reconciler must not auto-finish a goal task. Only the goal status `done` or `blocked` finishes it. The manager must not write the completion marker while it waits.
- Every agent sends a heartbeat on every stage change. The note is short: `feature 2/5, stage verification`.
- The result of every stage stays on the board. Nothing is only in the chat.
- The board manager writes the final result in the task result field. The user reads it in the task window.
- The board manager waits for the user at the proposal. The wait has no time limit, but the user can stop it.

## Interface (what the user sees)

- New input: **"Goal"** in the board. Or a mode switch in the Chat panel: `Ask` | `Goal`.
- The user writes: title, what it wants, acceptance criteria (optional), team and model (optional). The user does not choose a request type. The manager sizes the work.
- The board creates the goal task (role `manager`) and starts it. The board manager writes the proposal.
- **Goal panel** (new), three blocks:
  1. **Open questions** — the questions of the board manager. Each with a text field, the choices, a default button and a skip button.
  2. **Proposal** — the head (size, estimate, why, version) and the proposal list. Buttons per item: Accept, Edit, Reject. Buttons for the whole list: Accept all, Correct the size, Request changes.
  3. **Progress** — the feature orchestrators as columns, the step of each, the notes of the agents.
- The Chat panel shows the goal task session: live feed and messages to the board manager.
- The user can:
  - answer the open questions,
  - approve, correct or reject the proposal,
  - stop the manager (stop the task),
  - send a message to the manager (`kanban_message_to`),
  - open a feature orchestrator or a step task and read its result,
  - read the plan and the feature list.

## Manager prompt

New file: `prompts/board-manager-preamble.md`.

Same pattern as `prompts/board-assistant-preamble.md`: one file, rendered into the session as a durable instruction entry. The file holds:

- the role of the manager,
- the open question rules and the wait for the answer,
- the sizing rules (how the manager estimates the work),
- the proposal rules and the approval wait,
- the loop and the order of the steps,
- the stop rules,
- the tool list and what each tool is for,
- "never sleep, never poll — end your turn",
- the result format.

## Data to add

Small changes. Today the board has no place for a goal, a plan, a proposal or a question.

| Change | Where |
|---|---|
| Task kind `goal` (or `kind=service` + role) | `server/kanban.py` (`tasks.kind`), `src/types.ts` |
| Task role: `manager` or `feature` (the board must know the kind of session) | new column `role` in `tasks` |
| Task status `proposed` (proposal items) | `server/kanban.py` (`VALID_STATUSES`), board columns, filters |
| Proposal item fields: `area` (file area of the project) | new column in `tasks` or in the goal plan JSON |
| Goal row: `goal_status` (proposed, waiting, approved, running, done, failed), `size` (small, medium, large), `estimate` (JSON), `plan` (JSON list of features), `proposal_version`, `approved_snapshot` (JSON) | new columns in `tasks` or a new table `goals` |
| Open questions: `id`, `goal_id`, `item_id`, `question`, `why`, `options` (JSON), `default_answer`, `answer`, `state` | new table `goal_questions` (or a JSON column on the goal) |
| Stage decisions: `goal_id`, `feature_id`, `stage`, `task_id`, `attempt`, `accepted`, `evidence`, `reason`, `next_action`, `processed_event_id` | new table `stage_decisions` |
| Dispatch ledger: `client_key` (idempotency key) → `task_id` | new column on `tasks` + a unique index |
| API: `GET/POST /api/kanban/goals`, `GET /api/kanban/goals/:id/state` (one compact snapshot), `POST /api/kanban/goals/:id/proposal` (accept, reject, edit, version), `POST /api/kanban/goals/:id/questions/:qid/answer` | `vite.config.js` |
| Structured events: the link-back delivers `{eventId, goalId, taskId, stage, attempt}` | `vite.config.js` (`deliverResultsToParents`) |
| Queue the decision and the answer into the board manager session (like the result link-back) | `vite.config.js` |
| Server-side budget and cancellation: budget check in the delegate endpoint, stop cancels the descendants | `vite.config.js`, `server/kanban.py` |
| Board UI: goal panel, question block, proposal list, accept / edit / reject buttons, feature orchestrator columns | `src/App.tsx`, new component |
| Prompt files: the board manager and the feature orchestrator | `prompts/board-manager-preamble.md`, `prompts/feature-orchestrator-task.md` (the manager writes the orchestrator instructions into the delegated task) |
| Budget: max run time, max steps, max tokens | new. No mechanism today. |

The plan, the proposal and the questions must live on the board. A chat session can die. The board is the memory of the manager.

## Build order (MVP)

1. **Manager as a task.** The user writes the request in the Chat panel. The board creates a goal task (role `manager`) and starts it. The manager prompt file.
2. **Open questions.** The board manager writes questions. The goal panel shows them. The answer comes back into the manager session.
3. **The proposal.** The board manager sizes the work, writes the proposal items and the head. The goal panel shows them. The user accepts, edits, rejects or corrects the size. The decision comes back into the manager session.
4. **Feature flow.** The board manager delegates one feature orchestrator per feature. It runs the 5 steps, the board manager checks the results and the merge.
5. **Many orchestrator sessions.** The board manager starts one feature orchestrator per approved feature, all at the same time. Every feature has its own worktree. The results come back to the manager session.
6. **Repairs and stop rules.** A failed stage gets a repair task. 3 tries. Then ask the user.
7. **Goal UI and budget.** Feature columns, plan list, progress, stop button, limits.

## Points to decide

- Should the manager write code itself for small fixes, or always delegate?
- How long may a goal run? (time, steps, tokens)
- Must the manager ask the user again before it merges into the project branch?
- What is the manager model? It needs a strong model for planning and for checking the results.
- Should the user see a cost estimate in the proposal?
- How exact must the size estimate be? The manager may be wrong. The user can correct it.
- What happens when two goals run in the same project at the same time? (feature worktrees keep the files apart, but the merge order is not clear)
- Should a rejected proposal item stay on the board for the history, or be deleted?
- How many open questions may the manager ask before the proposal? (the concept says 3 at a time)

## Relation to the existing parts

| Part | Use |
|---|---|
| `kanban_feature` | The feature worktree and branch for every accepted feature. |
| `kanban_delegate` | The 5 steps. `wait=false`, `featureId`, `blockedByTaskIds`. A task without a feature gets its own worktree, so parallel tasks never share files. |
| `kanban_heartbeat` | The progress note on the manager card. |
| `kanban_task_result` | The result of the manager at the end. |
| Result link-back (RESULT_HANDOFF_CONCEPT) | The result of a step comes into the manager session. No polling. The same pattern carries the decision of the user. |
| Task-to-task link (`parentTaskId`) | The proposal items and the step tasks are children of the manager task. |
| One writer per worktree (WORKTREE_ISOLATION_CONCEPT) | The rule that makes parallel work safe: parallel items never share a worktree. |
| Board assistant (CHAT_TO_TASK_CONCEPT) | The panel is the view of the manager task. |
