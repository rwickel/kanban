# Integration Test Matrix

| ID | Acceptance check | Status |
|---|---|---|
| REQ-SINGLE-ENV-01 | Vite and MCP import the shared root environment loader. | verified |
| REQ-SINGLE-ENV-02 | `npm run dev` targets the shared launcher for Vite and OpenCode Serve. | verified |
| REQ-SINGLE-ENV-03 | `.kanban-data/opencode.json` is absent and no runtime source references it. | verified |
| REQ-SINGLE-ENV-04 | Global Kanban MCP config contains no credential environment block. | verified |
| REQ-SINGLE-ENV-05 | Browser UI displays only URL and password-presence state. | verified |

Checks:

- `npm test`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Node syntax checks: passed.
- Current server authentication with the new `.env`: pending restart because the existing server retains its startup environment.
