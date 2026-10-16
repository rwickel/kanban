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
   and assigns the work.
2. **Planner** defines scope, acceptance criteria, risks, and verification.
3. **Coder** creates a dedicated Git worktree and feature branch for the task.
   Never implement feature work directly in the shared checkout or on `main`.
4. **Testing** adds or runs tests and reports reproducible results.
5. **Reviewer** checks the complete diff and blocks unsafe or incomplete work.
6. Run the required end-to-end tests against the real application flow.
7. **Integrator** opens a GitHub pull request only after E2E tests pass and includes their
   command and result in the pull request description.
8. The authorized integrator merges the approved GitHub pull request after
   CI and review checks pass.

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
