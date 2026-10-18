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
