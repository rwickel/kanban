# Software Requirements

| ID | Requirement | Acceptance check |
|---|---|---|
| REQ-SINGLE-ENV-01 | Vite and Kanban MCP must read OpenCode settings from the root `.env`. | Both processes load the shared environment module. |
| REQ-SINGLE-ENV-02 | `npm run dev` must start Vite and OpenCode Serve with the same environment. | Both child processes start from one launcher. |
| REQ-SINGLE-ENV-03 | The app must not read or write `.kanban-data/opencode.json`. | No source reference remains and the file is absent. |
| REQ-SINGLE-ENV-04 | The global Kanban MCP configuration must not contain the OpenCode password. | Its environment block is absent. |
| REQ-SINGLE-ENV-05 | The browser must not accept or retain the server password. | The server modal is read-only and tests server-managed credentials. |

## Traceability

| Requirement | Software unit requirement |
|---|---|
| REQ-SINGLE-ENV-01 | SW-UR-ENV-01 |
| REQ-SINGLE-ENV-02 | SW-UR-LAUNCHER-01 |
| REQ-SINGLE-ENV-03 | SW-UR-SERVER-01 |
| REQ-SINGLE-ENV-04 | SW-UR-MCP-CONFIG-01 |
| REQ-SINGLE-ENV-05 | SW-UR-SERVER-02 |
