# REPORT — auto-continue-chat

## Scope

Opt-in "Automatisch fortsetzen" in the board-assistant chat (desktop +
mobile). After the configured idle time (default 300000 ms) one fixed
continuation prompt is sent into the SAME session. No new session, no board
task, no manual button (superseded by the checkbox). Idle time is
configurable on the Settings page.

## Changed files

| File | Change |
|---|---|
| `src/hooks/autoContinue.ts` | New. Pure threshold/history/idle logic, minute options, pref storage. |
| `src/hooks/autoContinue.test.ts` | New. 14 unit tests, pure time helper (injected `now`). |
| `src/hooks/useAutoContinue.ts` | New. Shared React timer hook: one send per cycle, cleanup on unmount. |
| `src/components/AssistantChatWindow.tsx` | Desktop checkbox + hook wiring. |
| `src/mobile/MobileChat.tsx` | Mobile checkbox + hook wiring (same hook, same inputs). |
| `src/components/SettingsPage.tsx` | "Auto-continue idle time" section: 1/5/10/15/30 minutes. |
| `vmodel/auto-continue-chat/*` | V-Model artifacts (concept, requirements, SW-UR, test matrix, report). |

`AGENTS.md` unchanged. No dependency files changed.

## Verification

- `node --test src/hooks/autoContinue.test.ts` → 14 pass, 0 fail.
  Covers threshold (299999/300000), reset, exclusions (disabled, task chat,
  busy, live/connecting/error/no-run, no session, no user history),
  delay clamping, minute normalization and conversion.
- `npm test` → 51 pass, 6 fail. All 6 failures are in
  `scripts/linkback.test.mjs` (pre-existing: the file passes 13/13 at HEAD,
  fails only with another task's uncommitted edits).
- `npm run typecheck` → 8 errors, all pre-existing and outside this feature:
  `src/App.tsx` (2: `replaceAll` lib target, null assignment),
  `src/components/AssistantChatWindow.tsx` (4: `project` possibly null inside
  the agent/model/ensure handlers from parallel uncommitted work),
  `src/prompts/boardAssistantPreamble.test.ts` (2: missing `serverUrl`).
  Verified pre-existing by stashing to HEAD and re-running.
  No errors in the new or edited lines of this feature.
- `npm run build` → success.

## Known pre-existing failures

See the typecheck and `linkback` list above. Not touched, to avoid conflicts
with the parallel model-selection and linkback tasks.

## Traceability

REQ-AC-01 … REQ-AC-11 → SW-UR-AUTOCONT-01 … SW-UR-AUTOCONT-10, see
`requirements.md` and `sw-unit-requirements.md`.
