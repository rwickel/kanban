# Software Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| REQ-PROVIDER-ERROR-01 | The chat must show a top-level provider error from an assistant message with empty content. | Parse the supplied payload into one error row. |
| REQ-PROVIDER-ERROR-02 | The chat must show the provider status and useful message. | Prefer embedded status and nested message, then use safe fallbacks. |

## Traceability

| Requirement | Software unit requirement |
|---|---|
| REQ-PROVIDER-ERROR-01 | SW-UR-CHAT-EVENTS-01 |
| REQ-PROVIDER-ERROR-02 | SW-UR-CHAT-EVENTS-02 |
