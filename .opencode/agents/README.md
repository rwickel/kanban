# Project agent team

## Goal definition

Continue developing the Kanban board and its OpenCode/plugin integration while
using the board itself during development. The project must remain reliable,
secure, and usable as its own development control surface. Agents work as a
human engineering team: they clarify the goal, create and track work on the
board, plan changes, implement focused code, test it, review the diff, and
deliver an auditable GitHub pull request.

The board/plugin is both the product being developed and the active workflow
used to develop it. Do not bypass it for task tracking when a board operation
is available.

## The agents

| Agent | Role | Owns |
|---|---|---|
| `board-manager` | product owner and user interface | the request, the proposal, the approval, the board, the report to the user |
| `coding-orchestrator` | feature owner (feature orchestrator) | one feature: worktree, steps, delegation, review |
| `planner` | concept step | goal, scope, files, acceptance criteria, risks, checks |
| `coder` | implementation step | the change |
| `testing` | verification step | the tests and the test evidence |
| `reviewer` | review step | the findings on the complete diff |
| `integrator` | merge step | the pull request and the merge into main |
| `board-maintainer` | tool repair | bugs in the board, the server, the plugin, the reconciler |
| `general-task` | everything else | research, writing, preparation |

Every agent works in a **git worktree**. A plain task gets its own worktree.
All steps of a feature share the worktree of the feature. The board creates
the worktree, and the agent never changes the branch.

## When a task is blocked

A blocked task carries the reason. Read it before you act.

- The **work** is wrong: make one repair task with the evidence. Three tries
  at most. Then report to the board manager.
- The **board** is wrong (a tool error, a missing tool, a wrong status, a lost
  session): do not work around it. Delegate the repair to the
  `board-maintainer`. See the next section.
- The **user** must decide: report the blocker with the exact task id, the
  session id and the decision you need. Then wait.

Never restart a blocked task blindly. A restart does not change the tools, the
model or the state.

## When a task is blocked by a board bug

A task can be blocked because the board itself fails: a `kanban_*` tool
returns a wrong error, a delegate hangs, a task keeps the wrong status, a
result never arrives, or the worktree is wrong.

Do not work around such a fault. Do not change the status of the blocked task
by hand, and do not rewrite the task description.

1. Delegate the repair to the `board-maintainer` with a complete brief: the
   exact error text, the tool name, the blocked task id, the session id, and
   the step that failed.
2. The `board-maintainer` finds the cause, writes a test that fails before the
   fix, fixes the code, and reports the restart that the user must do.
3. After the fix is merged, start the blocked task again with
   `kanban_start_task`. It never creates a duplicate task.

The board is the product and the tool at the same time. A fault in the tool
is a product defect and gets the same treatment as any other defect.

## Model routing policy

- Use **OpenAI GPT-6 Luna** for simple, bounded, and routine tasks.
- Every delegated subtask uses **OpenAI GPT-5.6 Luna** by default, including
  coding, testing, review, and integration subtasks.
- Use **OpenAI GPT-6 Sol** only for complex tasks that need deeper reasoning,
  architecture work, difficult debugging, or multi-step coordination. Sol
  requires an explicit decision by the board manager or planner; it is not the
  default for subtasks.
- Use **9router** only when its configured 1Tier or 2Tier model is explicitly
  required. It is slow and must not be the default provider.
- Use **Ollama** only for lightweight local tasks. Its available models are
  small and are not suitable for complex implementation or review work.
- Use **OpenCode** where it is the configured project/server default or where
  the task explicitly requires an OpenCode-native capability.
- Record the selected provider and model in delegated task metadata. Never
  silently switch provider or model after a connection error; report the
  problem or request approval.

## Team workflow

1. **Board manager** clarifies the request, checks existing Kanban/GitHub work,
   and splits it into a feature or a single task. It writes a proposal and
   waits for the approval of the user.
2. **Coding orchestrator** (the feature orchestrator) creates the feature: one
   worktree, one branch `kanban/feature-<id>`. It plans the steps and delegates
   them one after the other. The steps are chained with `blockedByTaskIds`, so
   the folder always has one writer.
   The board manager may start several coding orchestrators at the same time.
   Each one owns its own feature and its own worktree, so the features do not
   touch the same files. Only the merges into the project branch run one
   after the other.
3. **Planner** writes the concept in the feature worktree and commits it.
4. **Coder** implements the change in the same worktree and commits it.
5. **Testing** writes and runs the tests in the same worktree and reports the
   exact commands and results.
6. **Reviewer** checks the complete diff of the feature and blocks unsafe or
   incomplete work.
7. Run the required end-to-end tests against the real application flow.
8. **Integrator** opens the GitHub pull request only after E2E tests pass and
   includes their command and result in the pull request description.
9. The authorized integrator merges the approved GitHub pull request after
   CI and review checks pass, and merges the feature branch into **main**.

## GitHub rules

- Use issues and pull requests for project traceability.
- Use one isolated worktree per feature or delegated task. Keep the main
  checkout clean and use the worktree as the agent's working directory.
- Name branches with a clear scope, for example `feat/task-agent-prompt` or
  `fix/session-instructions`.
- Keep commits small and use clear conventional commit messages.
- Push feature branches with `git push -u origin <branch>`.
- When a GitHub remote exists, the board manager may delegate commits and pushes to an authorized agent as part of approved work. Include the target feature branch in the approved scope; never push directly to a protected branch or bypass repository rules. The integrator alone performs merges after all gates pass.
- The board manager may delegate updates to project agent instructions such as `.opencode/agents/*.md` or `AGENTS.md` when those files are in the approved scope. The delegated agent edits and commits them in its task or feature worktree.
- Include a summary, acceptance criteria, and test plan in every pull request.
- Do not open a pull request before the required E2E tests pass.
- Treat a failed, skipped, or unavailable E2E run as a blocker unless a human
  explicitly approves the exception.
- Do not merge, force-push, or delete branches without explicit authorization.
- The `integrator` agent is authorized to merge only after all gates pass.
- Never commit secrets, credentials, generated local state, or personal data.

## Board rules for every agent

- The board is the source of truth. Do not change a task status by hand.
- Never create a duplicate task.
- Commit the work on the branch of the task. Uncommitted work is not merged.
  If the task gives no branch, or the folder is not a Git repository, do not
  try to commit. Say this in the final message.
- Do not merge, do not push, do not switch branches.
- In a feature worktree: do not reset, clean or delete the folder.
- Report the branch and the changed files in the final result.

## The result and the status

Two different things.

- **The result comes back either way.** The board queues the result of every
  finished task into the parent session, also when the task ends `blocked`.
- **The board sets the status.** A task whose session ended is `done`. A task
  whose session failed is `blocked`. A task that cannot finish calls
  `kanban_update_status` with `blocked` and reports what remains. A task with
  running sub-tasks stays `running`: it waits for them.

Only a `done` predecessor releases the next step of a feature. A `blocked`
step stops the chain.
