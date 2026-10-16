# Software unit requirements — auto-continue-chat

| ID | Software unit | Requirement |
|---|---|---|
| SW-UR-AUTOCONT-01 | `src/hooks/autoContinue.ts` `shouldAutoContinue` | True only when enabled, assistant, session id present, not busy, user history, idle status (`closed`/`idle`), and `now - lastActivityAt >= idleMs`. |
| SW-UR-AUTOCONT-02 | `src/hooks/autoContinue.ts` `hasUserHistory` | True only with at least one non-empty user message. |
| SW-UR-AUTOCONT-03 | `src/hooks/autoContinue.ts` `isIdleStatus` | Only `closed` and `idle` count. `live`, `connecting`, `error`, `no-run`, null do not. |
| SW-UR-AUTOCONT-04 | `src/hooks/autoContinue.ts` `msUntilAutoContinue` | Remaining ms until the window ends, clamped at 0. Unknown start returns the full idle time. |
| SW-UR-AUTOCONT-05 | `src/hooks/autoContinue.ts` pref helpers | `readAutoContinuePref` returns false when unset or on storage error. `saveAutoContinuePref` stores `1` or removes the key. |
| SW-UR-AUTOCONT-06 | `src/hooks/useAutoContinue.ts` | Arms one timer. Fires `send(AUTO_CONTINUE_PROMPT)` once per cycle. Resets on activity token change, session switch, busy, and send outcome (success or failure). Cleanup clears the timer. No send after unmount. |
| SW-UR-AUTOCONT-07 | Chat windows | Checkbox "Automatisch fortsetzen" with `aria-label` and linked `label`. Same hook inputs on desktop and mobile. |
| SW-UR-AUTOCONT-08 | `src/hooks/autoContinue.ts` `AUTO_CONTINUE_MIN_OPTIONS`, `normalizeAutoContinueMin`, `autoContinueMinToMs` | Options `[1, 5, 10, 15, 30]`. Unknown values fall back to 5. Minutes convert to milliseconds. |
| SW-UR-AUTOCONT-09 | `src/hooks/autoContinue.ts` idle pref helpers | `readAutoContinueIdleMin` returns the stored value or 5 on error. `saveAutoContinueIdleMin` stores a normalized value. |
| SW-UR-AUTOCONT-10 | `src/components/SettingsPage.tsx`, chat windows | Settings page offers the minute choices and persists the choice. Both chats pass `autoContinueMinToMs(readAutoContinueIdleMin())` as `idleMs` to the hook. The hook default stays `AUTO_CONTINUE_IDLE_MS`. |
