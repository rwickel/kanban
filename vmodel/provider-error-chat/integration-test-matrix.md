# Integration Test Matrix

| ID | Acceptance check | Status |
|---|---|---|
| REQ-PROVIDER-ERROR-01 | The supplied assistant payload becomes a visible `ChatMessage` error row. | verified |
| REQ-PROVIDER-ERROR-02 | The visible text is `Provider error [429]: Rate limit exceeded. Please try again later.` | verified |

Checks:

- `npm test`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
