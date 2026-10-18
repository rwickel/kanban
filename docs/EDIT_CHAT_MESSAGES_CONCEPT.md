# Edit chat messages — concept

## Goal

Allow a user to correct a message they already sent in the board assistant or
task chat, then continue the conversation from the corrected text without
creating a second chat window or losing the visible conversation context.

## Current constraint

Chat messages are read from an OpenCode session through `useSessionStream` and
sent with `sendPrompt`. The current UI treats the transcript as append-only.
The documented API has no message-edit endpoint. The design therefore uses the
existing session-history endpoints to create a corrected conversation branch;
it must not pretend that an edit is an ordinary appended prompt.

## User experience

1. Hover or focus a user-authored message to reveal **Edit**. On touch, show
   the action in the message action menu.
2. Open the message text in the existing composer, preserving line breaks.
3. Show **Save**, **Cancel**, and a character/validation state. Empty or
   whitespace-only messages cannot be saved.
4. Saving replaces the selected message and resumes the session from that
   point. Later messages are marked as superseded or removed from the active
   branch, with a confirmation when they contain tool calls or assistant work.
5. On success, scroll to the edited message and show a brief “Edited” label.
   On failure, keep the draft and display a retryable error.

Editing is available only for user messages owned by the current session.
Assistant, system, tool, and synthetic messages are read-only.

## Existing endpoint flow

The first implementation uses these documented endpoints:

1. `GET /api/session/{sessionID}/message` — load the transcript and locate the
   selected user message.
2. `POST /api/session/{sessionID}/fork` with `{ before: messageID }` — create a
   child session containing history before the selected message.
3. `POST /api/session/{childSessionID}/prompt` with `{ text }` — send the
   corrected message as the first new user turn in the child session.
4. `GET /api/session/{childSessionID}/message` — refresh the visible transcript
   from the corrected branch.

The original session remains unchanged and can be reopened. The UI should
label the child session as the edited branch and persist its id for the active
chat. Do not use `POST /synthetic` for edits because it would add a message
without replaying the conversation. Do not use `POST /prompt` on the original
session because that creates a duplicate append-only message.

If the upstream `fork` endpoint cannot accept a message boundary, editing is
unsupported until a server-side replay adapter exists. The UI must report that
state and preserve the original transcript.

## Module boundaries

- `src/api/opencode.ts`: typed `forkSession`, `sendPrompt`, and message-list
  functions, plus a small `editMessage` orchestration function that returns
  the child session id.
- `src/components/ChatFeed.tsx`: render edit affordance and edited state;
  remain presentation-focused.
- `src/components/SessionChatWindow.tsx` and
  `src/components/AssistantChatWindow.tsx`: own edit state, save/cancel flow,
  and stream refresh. Share a small hook if the flows remain identical.
- Server route/adapter: validation, authorization, upstream edit call, and
  error translation.
- Tests: unit-test validation and API serialization; integration-test the
  route through the same wrapper used by the app; E2E-test edit, cancel,
  unsupported, and failure flows.

## Requirements

- **REQ-EDIT-001**: A user can edit only their own user-authored message.
- **REQ-EDIT-002**: Saving creates a corrected child branch from the selected
  message boundary and sends the replacement text only to that branch.
- **REQ-EDIT-003**: Blank, oversized, or invalid input is rejected before the
  upstream request.
- **REQ-EDIT-004**: Cancel leaves the transcript and composer unchanged.
- **REQ-EDIT-005**: Unsupported or failed edits preserve the original session
  and provide a retryable error.
- **REQ-EDIT-006**: Assistant, system, tool, and synthetic messages expose no
  edit control.
- **REQ-EDIT-007**: Desktop keyboard focus and touch targets remain accessible.

## Non-goals for the first version

- Editing assistant or tool output.
- Arbitrary branch browsing or merge conflict resolution.
- Editing while a response is actively streaming.
- Permanent audit-history UI beyond the server's revision/branch metadata.

## Delivery gates

1. Confirm the deployed OpenCode API supports message replacement or branch
   replay. If not, define the server-side replay strategy first.
2. Implement and test the server contract and authorization checks.
3. Add the typed client and shared feed affordance.
4. Integrate both chat windows and verify transcript refresh behavior.
5. Run unit, integration, and critical-path E2E tests before release.
