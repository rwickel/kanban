# Software requirements — auto-continue-chat

| ID | Requirement | Acceptance check |
|---|---|---|
| REQ-AC-01 | Auto-continue may send only after the configured idle time (default 300000 ms) of real inactivity of a board-assistant session. | Threshold test: 299999 ms no, 300000 ms yes. |
| REQ-AC-02 | One cycle sends exactly one fixed prompt into the SAME session. | One send per cycle; the same session id goes to `sendPrompt`. |
| REQ-AC-03 | Auto-continue never creates a new session and never creates a board task. | Send path calls `sendPrompt` only. |
| REQ-AC-04 | Desktop and mobile behave identically. | Both windows use the shared `useAutoContinue` hook. |
| REQ-AC-05 | The timer is removed on cleanup. Nothing sends after unmount. | `clearTimeout` in effect cleanup plus mounted guard. |
| REQ-AC-06 | The checkbox has one unambiguous name for keyboard and screen reader. | `label` + `htmlFor` + `aria-label` "Automatisch fortsetzen". |
| REQ-AC-07 | Tests use a pure time helper and cover threshold, reset, and exclusions. | `src/hooks/autoContinue.test.ts`. |
| REQ-AC-08 | The option is OFF by default and persisted per project. | `readAutoContinuePref` returns false when unset. |
| REQ-AC-09 | A send failure stays visible and re-arms the timer. | `sendError` shows the failure; a later cycle may retry. |
| REQ-AC-10 | Normal task chats never auto-continue. | `isAssistant: false` disables the hook. |
| REQ-AC-11 | The idle time is configurable on the Settings page. Allowed values: 1, 5, 10, 15, 30 minutes. Default stays 5 minutes (300000 ms). | Settings choice saves the value; the chat passes it to the hook as `idleMs`. |

## Traceability

| Requirement | Software unit requirement |
|---|---|
| REQ-AC-01 | SW-UR-AUTOCONT-01, SW-UR-AUTOCONT-04 |
| REQ-AC-02 | SW-UR-AUTOCONT-06 |
| REQ-AC-03 | SW-UR-AUTOCONT-06 |
| REQ-AC-04 | SW-UR-AUTOCONT-06 |
| REQ-AC-05 | SW-UR-AUTOCONT-06 |
| REQ-AC-06 | SW-UR-AUTOCONT-07 |
| REQ-AC-07 | SW-UR-AUTOCONT-01, SW-UR-AUTOCONT-02, SW-UR-AUTOCONT-03, SW-UR-AUTOCONT-04 |
| REQ-AC-08 | SW-UR-AUTOCONT-05 |
| REQ-AC-09 | SW-UR-AUTOCONT-06 |
| REQ-AC-10 | SW-UR-AUTOCONT-01 |
| REQ-AC-11 | SW-UR-AUTOCONT-08, SW-UR-AUTOCONT-09, SW-UR-AUTOCONT-10 |
