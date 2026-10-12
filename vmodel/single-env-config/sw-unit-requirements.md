# Software Unit Requirements

## SW-UR-ENV-01

- Purpose: Load root environment settings consistently.
- Interface: `parseEnv(text)` and `loadEnvFile(path)`.
- Data contract: Preserve Windows paths and equals signs. Support comments and quoted values.
- Requirements: REQ-SINGLE-ENV-01.
- Test: `scripts/env.test.mjs`.

## SW-UR-LAUNCHER-01

- Purpose: Start both development services.
- Interface: `npm run dev`.
- Data contract: Pass one loaded environment to Vite and OpenCode Serve.
- Requirements: REQ-SINGLE-ENV-02.

## SW-UR-SERVER-01

- Purpose: Remove file-based credential persistence.
- Interface: OpenCode proxy and delegation helpers.
- Data contract: Read URL and password from environment only.
- Requirements: REQ-SINGLE-ENV-03.

## SW-UR-MCP-CONFIG-01

- Purpose: Remove duplicated MCP credentials.
- Interface: Global OpenCode Kanban MCP entry.
- Data contract: Store only the local MCP command and enabled state.
- Requirements: REQ-SINGLE-ENV-04.

## SW-UR-SERVER-02

- Purpose: Keep credentials outside the browser.
- Interface: Server configuration modal and test endpoint.
- Data contract: Return URL and `hasPassword`; never return or accept a password.
- Requirements: REQ-SINGLE-ENV-05.
