# Kanban HTTP API (`http://localhost:3001/api`)

Vite dev server on port `3001` serves **two** API surfaces.
They look similar but differ in auth and ownership.

| Prefix | Owner | Auth | Backed by |
| ------ | ----- | ---- | --------- |
| `/api/kanban/*` | Local kanban store | none | `server/kanban.py` (SQLite `.kanban-data/kanban.db`), via `kanbanApi()` in `vite.config.js` |
| `/api/*` (everything else) | OpenCode server | HTTP Basic `opencode:<password>` (`OPENCODE_SERVER_PASSWORD`) | Proxied to `http://localhost:4096` (`server.proxy` in `vite.config.js`) |

> Agents doing task sharing want `/api/kanban/*` (no auth).
> `/api/tasks` does **not** exist — it returns `401 UnauthorizedError`.
> The OpenCode route catalogue lives in
> [`OPENCODE_V2_ENDPOINTS.md`](./OPENCODE_V2_ENDPOINTS.md).
>
> **Live discovery:** the dev server serves its own catalogue —
> `GET /api/kanban/docs` (interactive try-it-out HTML page, no auth —
> open it in the browser to test every endpoint),
> `GET /api/kanban/docs?format=json` (machine-readable route list, used
> by the in-app API Explorer), and
> `GET /api/kanban/openapi.json` (OpenAPI 3.0 spec).
> All three are generated in `vite.config.js` next to the router so they
> can't drift from the implementation.

## Quick probe (PowerShell)

```powershell
# local store — no auth
Invoke-WebRequest http://localhost:3001/api/kanban/tasks -UseBasicParsing |
  Select-Object -ExpandProperty Content

Invoke-WebRequest http://localhost:3001/api/kanban/projects -UseBasicParsing |
  Select-Object -ExpandProperty Content

# OpenCode proxy — needs password, else 401 {"_tag":"UnauthorizedError",...}
Invoke-WebRequest http://localhost:3001/api/info -UseBasicParsing
```

## Tasks — `/api/kanban/tasks`

### `GET /api/kanban/tasks?projectId=&status=`

List tasks, newest first. Both query params optional.

```powershell
Invoke-WebRequest "http://localhost:3001/api/kanban/tasks?projectId=6abb0e48-adf0-420d-ab94-51cb3832f79e&status=done" -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

`status` must be `backlog|running|done|blocked`, else `400 { ok:false, error:"invalid status" }`.
Returns `Task[]`:

```json
{
  "id": "5e344f3b-6909-4fb4-9bcf-ab43393922f1",
  "projectId": "6abb0e48-adf0-420d-ab94-51cb3832f79e",
  "title": "Buy groceries",
  "description": "Pseudo task: milk, eggs, bread",
  "status": "done",
  "priority": "medium",
  "agentId": "build",
  "agentName": "Build",
  "sessionId": "ses_...",
  "modelId": null,
  "modelProviderID": null,
  "startupPhase": "ready",
  "startupError": null,
  "createdAt": "2026-10-09T12:44:01.285251+00:00",
  "updatedAt": "2026-10-09T13:02:54.958351+00:00"
}
```

### `GET /api/kanban/tasks/:id`

```powershell
Invoke-WebRequest http://localhost:3001/api/kanban/tasks/5e344f3b-6909-4fb4-9bcf-ab43393922f1 -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

Missing id → `404 { ok:false, error:"Task not found: <id>" }`.

### `POST /api/kanban/tasks`

Body (JSON): `projectId` + `title` required; optional
`description`, `status`, `priority`, `id`, `agentId`, `agentName`,
`sessionId`, `modelId`, `modelProviderID`, `startupPhase`, `startupError`.

```powershell
$body = @{
  projectId   = "6abb0e48-adf0-420d-ab94-51cb3832f79e"
  title       = "Add tests"
  description = "Follow-up split from Buy groceries"
  priority    = "high"
} | ConvertTo-Json

Invoke-WebRequest http://localhost:3001/api/kanban/tasks `
  -Method POST -ContentType "application/json" -Body $body -UseBasicParsing |
  Select-Object -ExpandProperty Content
# → created Task JSON (actor recorded as "board")
```

Missing `projectId`/`title` → `400 { ok:false, error:"projectId and title required" }`.

### `PATCH /api/kanban/tasks/:id`

Partial update — any of `title`, `description`, `status`, `priority`,
`agentId`, `agentName`, `sessionId`, `modelId`, `modelProviderID`,
`startupPhase`, `startupError`. This is how the board pins a session
and how an agent-equivalent HTTP call flips state:

```powershell
Invoke-WebRequest http://localhost:3001/api/kanban/tasks/5e344f3b-6909-4fb4-9bcf-ab43393922f1 `
  -Method PATCH -ContentType "application/json" -Body '{"status":"done"}' `
  -TimeoutSec 30 -UseBasicParsing |
  Select-Object -ExpandProperty Content
# → updated Task JSON
```

> Note: the first PATCH attempt after an idle dev server can exceed a
> short (5 s) client timeout — the Python CLI cold-start is slow.
> Retry with `-TimeoutSec 30`; the write still lands.

### `DELETE /api/kanban/tasks/:id`

```powershell
Invoke-WebRequest http://localhost:3001/api/kanban/tasks/<id> -Method DELETE -UseBasicParsing |
  Select-Object -ExpandProperty Content
# → {"ok":true,"deleted":"<id>"}
```

## Projects — `/api/kanban/projects`

### `GET /api/kanban/projects`

```powershell
Invoke-WebRequest http://localhost:3001/api/kanban/projects -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

Returns `Project[]`:

```json
{
  "id": "6abb0e48-adf0-420d-ab94-51cb3832f79e",
  "name": "test",
  "path": "C:\\Users\\Robert\\work\\test",
  "folder": "test",
  "gitUrl": "https://github.com/rwickel/test.git",
  "gitBranch": "main",
  "description": "test project for testing the kanban app",
  "agentIds": [],
  "createdAt": "2026-10-09T12:07:17.765559+00:00"
}
```

### `POST /api/kanban/projects`

Body: `name` required; optional `folder` (preferred) or legacy `path`
(must sit inside `KANBAN_PROJECTS_ROOT`), `gitUrl`, `gitBranch`,
`noMkdir`, `description`, `id`, `agentIds[]`.

### `PATCH` / `PUT /api/kanban/projects/:id`

Optional `name`, `folder` (re-derives `path`) or `path`, `gitUrl`,
`gitBranch`, `description`, `agentIds[]`.

### `DELETE /api/kanban/projects/:id`

Deletes the project **and its tasks**: `{"ok":true,"deleted":"<id>","tasksDeleted":n}`.

### `GET /api/kanban/projects/:id/git-check`

Branch pin check → `{ ok, current, pinned }`, e.g.
`{"ok":true,"current":"main","pinned":"main"}`.

## Folders / clone — `/api/kanban/roots|folders|clone`

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/kanban/roots` | `{ root, folders }` — folders under `KANBAN_PROJECTS_ROOT` |
| GET | `/api/kanban/folders` | same as `/roots` |
| GET | `/api/kanban/folders/:name/git` | git info: `{ folder, isRepo, branch, dirty, remote, branches }` |
| POST | `/api/kanban/clone` | `{ url, folder, branch? }` → `git clone` into `ROOT/folder` |

`POST /api/kanban/clone` without `url`/`folder` →
`400 { ok:false, error:"url and folder required" }`.

## Delegate — `POST /api/kanban/delegate` (sync, like read/write)

Create a task **for another agent on the team**, execute it **immediately**,
and **wait** until it lands in `done`/`blocked` — then return the finished
Task. Behaves like a normal tool call that returns a value.

```powershell
$body = @{
  projectId   = "6abb0e48-adf0-420d-ab94-51cb3832f79e"
  title       = "Summarize README"
  description = "Write a 3-line summary of the repo README"
  agentId     = "build"
  timeoutSec  = 600
} | ConvertTo-Json

Invoke-WebRequest http://localhost:3001/api/kanban/delegate `
  -Method POST -ContentType "application/json" -Body $body `
  -TimeoutSec 660 -UseBasicParsing |
  Select-Object -ExpandProperty Content
# → {"task":{... finished Task ...},"sessionId":"ses_...","waited":true}
```

Body: `projectId*`, `title*`; optional `description`, `priority`,
`agentId`/`agentName` (must be in the project's team), `modelId`,
`modelProviderID`, `serverUrl`, `serverPassword`, `timeoutSec` (default 600,
cap 1800), `pollMs` (default 3000), `wait` (default true — false =
fire-and-forget, returns right after starting).

How it works: creates the subtask → flips it to `running` → spawns a session
in the project dir via the OpenCode server → sends the prompt (which tells the
teammate to finish with `PATCH …/tasks/:id {"status":"done"}`) → polls SQLite
until `done`/`blocked` or the timeout. Spawn/prompt failures park the subtask
as `blocked` with `startupError`. Auth to OpenCode comes from (in order): `serverPassword` field, the
stored creds file (`.kanban-data/opencode.json`, written once via the Server
modal → `PUT /api/kanban/server` or `OPENCODE_SERVER_PASSWORD` /
`KANBAN_OPENCODE_PASSWORD` env).
**Give the client a generous `-TimeoutSec`** (≥ `timeoutSec`).

### `GET` / `PUT /api/kanban/server`

One-time creds storage so delegate needs **no per-call password**:
`PUT { url?, password? }` → `{ ok, url, hasPassword }` (stored in
`.kanban-data/opencode.json`, `GET` never returns the secret). The Server
modal writes it on every Save.

## Events — `/api/kanban/events`

### `GET /api/kanban/events?task=&limit=50`

Audit log, newest first.

```powershell
Invoke-WebRequest "http://localhost:3001/api/kanban/events?limit=5" -UseBasicParsing |
  Select-Object -ExpandProperty Content
```

```json
{
  "id": 100,
  "ts": "2026-10-09T12:57:49.099770+00:00",
  "task_id": null,
  "actor": "board",
  "action": "task.deleted",
  "details": "{\"id\": \"6a97eda8-...\", \"title\": \"Write the quarterly report\"}"
}
```

## Errors

| Code | Meaning |
| ---- | ------- |
| 400 | bad input (`invalid status`, `projectId and title required`, `name required`, `url and folder required`) |
| 404 | `unknown kanban route`, or `Task/Project not found: <id>` (only missing DB rows map to 404) |
| 500 | anything else, e.g. failed `git clone` (its stderr mentions "Repository not found" but stays a 500) |
| 401 | **only** on the OpenCode proxy (`/api/*` minus `/api/kanban`): `{"_tag":"UnauthorizedError","message":"Authentication required"}` |

## MCP equivalents (`mcp-kanban/server.js`)

Same SQLite rows, stdio transport, actor recorded as `"agent"`:

| MCP tool | HTTP equivalent |
| -------- | --------------- |
| `kanban_update_status {taskId,status}` | `PATCH /api/kanban/tasks/:id {status}` |
| `kanban_create_task {projectId,title,...}` | `POST /api/kanban/tasks` |
| `kanban_update_task {taskId,...}` | `PATCH /api/kanban/tasks/:id` |
| `kanban_list_tasks {projectId?,status?}` | `GET /api/kanban/tasks?...` |
| `kanban_task_status {taskId?}` | `GET /api/kanban/tasks/:id` or `GET /api/kanban/events` |
| `kanban_delegate {projectId,title,...}` | `POST /api/kanban/delegate` — sync: create + run + WAIT for done |

Canonical reference: [`vite.config.js` `kanbanApi()`](../vite.config.js) (routes),
[`server/kanban.py`](../server/kanban.py) (store/CLI), [`README.md`](../README.md) (workflow).
