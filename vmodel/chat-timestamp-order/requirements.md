# Software Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| REQ-TIME-01 | The chat feed must be ordered by each message's timestamp, not by its position in the server JSON array. | A provider error that is last in the JSON but has an earlier timestamp renders at its chronological position. |
| REQ-TIME-02 | Rows without a timestamp must sort after all stamped rows and keep their relative server order. | Unstamped rows stay in arrival order at the end of the feed. |
| REQ-TIME-03 | Equal timestamps must preserve server order (stable sort). | Two messages with the same ms keep their array order. |
| REQ-TIME-04 | All chat rows derived from one raw message must share that message's timestamp. | Tool rows / subcalls / error rows of a message carry the same `createdAtMs`. |
| REQ-TIME-05 | Live/closed idle detection must compare the idle marker's timestamp against the last chat message's timestamp, not array indices. | An idle marker mid-array by time does not flip the session status. |
| REQ-TIME-06 | Timestamp extraction must tolerate seconds-vs-ms values and `time` nested under `info`. | `time.created` in seconds normalizes to ms; `info.time.created` is found. |

## Traceability

| Requirement | Software unit requirement |
|---|---|
| REQ-TIME-01 | SW-UR-CHAT-EVENTS-TIME-01 |
| REQ-TIME-02 | SW-UR-CHAT-EVENTS-TIME-02 |
| REQ-TIME-03 | SW-UR-CHAT-EVENTS-TIME-02 |
| REQ-TIME-04 | SW-UR-CHAT-EVENTS-TIME-01 |
| REQ-TIME-05 | SW-UR-SESSION-STREAM-TIME-01 |
| REQ-TIME-06 | SW-UR-CHAT-EVENTS-TIME-03 |
