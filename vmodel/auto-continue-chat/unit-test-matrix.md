# Unit test matrix — auto-continue-chat

Runner: `node --test` with injected `now` values (pure time helper, no real
clock waits). File: `src/hooks/autoContinue.test.ts`.

| Test | Requirement |
|---|---|
| prompt is fixed, understandable and repeat-safe | REQ-AC-02 |
| threshold: fires only at exactly 300000 ms or more | REQ-AC-01, REQ-AC-07 |
| reset: new activity restarts the window | REQ-AC-01, REQ-AC-07 |
| exclusions: disabled, task chat, no session | REQ-AC-08, REQ-AC-10 |
| exclusions: busy states never fire | REQ-AC-01 |
| exclusions: live/connecting/error/no-run statuses never fire | REQ-AC-01 |
| exclusions: fresh session without user history never fires | REQ-AC-01 |
| both closed and idle statuses are allowed | REQ-AC-01 |
| custom idleMs override works for fast tests | REQ-AC-07 |
| hasUserHistory requires a non-empty user turn | REQ-AC-07 |
| isIdleStatus only accepts closed and idle | REQ-AC-07 |
| msUntilAutoContinue counts down to zero and clamps | REQ-AC-07 |
| normalizeAutoContinueMin keeps known options and falls back to default | REQ-AC-11, REQ-AC-07 |
| autoContinueMinToMs converts minutes to milliseconds | REQ-AC-11, REQ-AC-07 |

Result: 14 tests, 14 pass, 0 fail.
