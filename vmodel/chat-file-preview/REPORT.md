# Chat File Preview Report

Status: CONCEPT

## Gates

| Phase | Evidence | Status |
|---|---|---|
| Concept and design | `concept-design.md`, `architecture.md` | passed |
| Software requirements | `requirements.md`, `sw-unit-requirements.md` | passed |
| Implementation | `src/components/filePaths.ts`, `src/components/ChatFeed.tsx`, `vite.config.js` | not started |
| Unit test | `unit-test-matrix.md` | planned |
| Integration test | `integration-test-matrix.md` | planned |

## Traceability

| Requirement | Unit requirement | Verification |
|---|---|---|
| REQ-CHAT-FILE-01 | SW-UR-FILEPATHS-01 | classification unit tests |
| REQ-CHAT-FILE-02 | SW-UR-FILEPATHS-02 | extensionless linkification tests |
| REQ-CHAT-FILE-03 | SW-UR-FILEPATHS-01 | classification unit tests |
| REQ-CHAT-FILE-04 | SW-UR-CHATFEED-01 | build + manual click check |
| REQ-CHAT-FILE-05 | SW-UR-VITE-ROOT-01 | curl against dev server |
| REQ-CHAT-FILE-06 | SW-UR-FILEPATHS-03 | filename label unit tests |

## Risks

- The root value can change when `.env` is edited. The client must refetch
  `/api/kanban/file/root` on startup, not cache across restarts.
- OpenCode v2 fs endpoints return raw bytes. The modal must keep the
  middleware as primary so size caps and truncation stay in one place.
- Case-sensitive root comparison can miss root paths on Windows. The
  comparison must be case-insensitive.
