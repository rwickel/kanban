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
| `board-manager` | product owner and user interface | the request, the board, the report to the user |
| `coding-orchestrator` | feature owner | one feature: worktree, steps, delegation, review |
| `planner` | concept step | goal, scope, files, acceptance criteria, risks, checks |
| `coder` | implementation step | the change |
| `testing` | verification step | the tests and the test evidence |
| `reviewer` | review step | the findings on the complete diff |
| `integrator` | merge step | the pull request and the merge into main |
| `general-task` | everything else | research, writing, preparation |

Every agent works in a **git worktree**. A plain task gets its own worktree.
All steps of a feature share the worktree of the feature. The board creates
the worktree, and the agent never changes the branch.

## Model routing policy

- Use **OpenAI GPT-5.6 Luna** for simple, bounded, and routine tasks.
- Every delegated subtask uses **OpenAI GPT-5.6 Luna** by default, including
  coding, testing, review, and integration subtasks.
- Use **OpenAI GPT-5.6 Sol** only for complex tasks that need deeper reasoning,
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
   and splits it into a feature or a single task.
2. **Coding orchestrator** creates the feature: one worktree, one branch
   `kanban/feature-<id>`. It plans the steps and delegates them one after the
   other. The steps are chained with `blockedByTaskIds`, so the folder always
   has one writer.
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
- Do not merge, do not push, do not switch branches.
- In a feature worktree: do not reset, clean or delete the folder.
- Report the branch and the changed files in the final result.

## The completion marker

Two different things.

- **The result comes back either way.** The board queues the result of every
  finished task into the parent session, also when the task ends `blocked`.
- **The marker sets the status.** The board reads the last message:
  `KANBAN_TASK_COMPLETE` → `done`, anything else → `blocked` with the reason
  "completion was not verified".

Only a `done` predecessor releases the next step of a feature. A `blocked`
step stops the chain.
