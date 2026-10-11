# Chat-to-Task — board assistant with its own session

## Goal

Board assistant chat uses its own OpenCode session per project.
It never creates a task on the board. Ask task stays closed while chat runs.

## Flow

```
[Header: Chat (C)] → AssistantChatWindow (project scoped)
  First send → createSession({ title: "Board assistant — <project>", directory: project.path })
    → store id in localStorage kanban_assistant_session_<projectId>
  User: "Explain the auth flow"
    → POST /api/session/<assistantId>/prompt
    → live feed via useSessionStream (same as SessionChatWindow)
    → reply, stop, markdown, file preview
No board task is created. No status change. No ask-task panel.
```

## Files

- `src/components/AssistantChatWindow.tsx` — own session per project, no board writes.
- `src/App.tsx` — Chat button, `C` shortcut, panel mount only.
- Reused: `src/api/opencode.ts` (`createSession`, `sendPrompt`, `interruptSession`), `src/hooks/useSessionStream.ts`, `src/components/chatEvents.ts`, `src/components/filePaths.ts`, `src/components/FilePreviewModal.tsx`.

## Rules

- Scope session to active `projectId` + `project.path`.
- Session id persists per project in localStorage.
- DEMO mode: createSession returns missing-path error, shown in panel.
- Board polls unchanged.
