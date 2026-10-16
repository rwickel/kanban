# Concept design — auto-continue-chat

Goal: an opt-in checkbox "Automatisch fortsetzen" in the board-assistant chat.
When it is ON and the session is idle for 5 minutes, one fixed prompt is sent
into the SAME session. The project continues without repeating done work.

Superseded: the earlier idea of a manual "Projekt fortsetzen" button. No
manual CTA is implemented.

## Behavior

- Default is OFF. The flag is persisted per project in localStorage.
- The idle time is configurable on the Settings page (1, 5, 10, 15, 30
  minutes; default 5 = 300000 ms) and stored in localStorage.
- Only board-assistant chats. Normal task chats never auto-continue.
- One fixed prompt: `AUTO_CONTINUE_PROMPT` in `src/hooks/autoContinue.ts`.
- One send per inactivity cycle. New activity, session switch, new chat, or a
  finished send attempt restarts the 5-minute window.
- Busy states (live, connecting, sending, stopping, interrupted) never fire.
- Fresh sessions without a user message never fire.
- Send errors use the existing `sendError` display and re-arm the timer.

## Structure

- `src/hooks/autoContinue.ts` — pure logic: threshold, idle status, history
  check, delay, pref storage. No React. Testable with injected `now`.
- `src/hooks/useAutoContinue.ts` — thin React hook: timer, one send per
  cycle, cleanup on unmount. Shared by desktop and mobile.
- `src/components/AssistantChatWindow.tsx` — desktop checkbox + wiring.
- `src/mobile/MobileChat.tsx` — mobile checkbox + wiring.

## Risk handling

The stream status can turn `closed` right after a run. Inactivity is derived
from the last visible activity (last message id + status token), not from the
status alone. A busy stream keeps pushing the window forward.
