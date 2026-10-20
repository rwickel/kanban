# Kanban Clone

Web kanban board with project-scoped agent chat, task chat, live session
updates, and mobile board support.

## Development

```bash
npm install
npm run dev
```

Run the type checker with:

```bash
npm run typecheck
```

## Chat

User messages support inline editing. Editing creates a session branch before
the selected message, removes later messages from the active transcript, and
sends the replacement text on the new branch. Agent-switch events appear as
bold, bubble-free status text.

See `docs/EDIT_CHAT_MESSAGES_CONCEPT.md` for the message editing design.

## Worktree isolation

Every task can run in its own git worktree. The agent session then works in
that folder, so two parallel tasks never share files, git index or build output.

- Worktree folder: `<KANBAN_WORKTREES_ROOT>/<project folder>/<task id>`.
  Default root: `<KANBAN_PROJECTS_ROOT>/.kanban-worktrees`.
- Branch: `kanban/task-<first 8 chars of the task id>`.
- The board merges the branch into the project branch when the task reaches
  `done`. A merge conflict is reported on the card, not merged.
- Set `KANBAN_WORKTREE_AUTOMERGE=0` to switch the automatic merge off.
- Projects without a git repo keep the plain project folder.

See `docs/KANBAN_API.md` for the worktree routes and the CLI commands.
See `docs/WORKTREE_ISOLATION_CONCEPT.md` for the diagrams and the use cases.
