# Chat Timestamp Order Report

## Scope

Ordered the chat feed by message timestamp instead of server JSON array position (see `concept-design.md`, `requirements.md`).

## Implementation

- `src/components/chatEvents.ts`
  - `messageTimestamp(raw)` (exported): probes `time.created`/`start`/`started`/`timestamp`/`createdAt` on `time`, the message, and `info.*`; completion times (`completed`/`end`/`finished`/`updated`) as fallback for error rows. Seconds-vs-ms and date-string normalization included (REQ-TIME-06).
  - `ChatMessage.createdAtMs?: number` — set conditionally so unstamped rows keep their exact shape.
  - `toChatMessage` stamps every derived row (user, assistant, reasoning, tool, execute wrapper + subcalls, file, provider-error, compaction/idle error) with the source message's time (REQ-TIME-04).
  - `toChatMessages` sorts stably ascending by `createdAtMs`; unstamped rows sort last; explicit index tiebreak for equal timestamps (REQ-TIME-01/02/03).
- `src/hooks/useSessionStream.ts`
  - New `scanSessionList()` replaces the two duplicated index-scan loops (poll + SSE). Idle/live now compares the idle marker's max timestamp vs the last chat message's max timestamp, falling back to index comparison only when either side is unstamped (REQ-TIME-05). Outcome extraction preserved.

## Verification

- `node --test src/components/chatEvents.test.ts`: 11/11 pass — 4 new tests cover chronological ordering of a mid-array-timestamp provider error, tie stability, unstamped-last ordering, shared `createdAtMs` on grouped rows, and `messageTimestamp` normalization/fallbacks.
- `tsc --noEmit`: no errors in `chatEvents.ts` / `useSessionStream.ts` (pre-existing errors in `App.tsx`, `AssistantChatWindow.tsx`, `boardAssistantPreamble.test.ts` untouched).
- Pre-existing failures in `scripts/linkback.test.mjs` and `src/hooks/autoContinue.test.ts` are unrelated (no dependency on the changed modules).

## Risks

- Mixed stamped/unstamped server lists fall back to array-index idle detection (old behavior) — intentional conservative fallback.
- `merge()` still appends server-dropped local ids at the end; they carry no server timestamp.
