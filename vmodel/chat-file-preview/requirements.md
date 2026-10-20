# Software Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| REQ-CHAT-FILE-01 | A markdown link whose href is an absolute path under the root opens the file modal. | Click `[label](C:\...\utf8)` in chat; modal shows the file content. |
| REQ-CHAT-FILE-02 | A bare absolute path under the root without a file extension becomes a clickable link. | Plain text `C:\...\kanban\utf8` renders as a link; click opens the modal. |
| REQ-CHAT-FILE-03 | Paths outside the root keep external-link behavior (new tab). | Click `[label](C:\Windows\win.ini)`; a new tab opens, no modal. |
| REQ-CHAT-FILE-04 | External links never replace the app window. | All external `href`s render with `target="_blank"`. |
| REQ-CHAT-FILE-05 | The root for classification comes from the server, not a client constant. | `GET /api/kanban/file/root` returns `{ root }`; client caches it. |
| REQ-CHAT-FILE-06 | Internal links show the filename only, never the full address. | Chat renders `[utf8.txt](file-preview:...)`; the full path stays in the href and title. |

## Traceability

| Requirement | Software unit requirement |
|---|---|
| REQ-CHAT-FILE-01 | SW-UR-FILEPATHS-01 |
| REQ-CHAT-FILE-02 | SW-UR-FILEPATHS-02 |
| REQ-CHAT-FILE-03 | SW-UR-FILEPATHS-01 |
| REQ-CHAT-FILE-04 | SW-UR-CHATFEED-01 |
| REQ-CHAT-FILE-05 | SW-UR-VITE-ROOT-01 |
| REQ-CHAT-FILE-06 | SW-UR-FILEPATHS-03 |
