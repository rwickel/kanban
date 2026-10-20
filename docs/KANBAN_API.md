# Kanban HTTP API (`http://localhost:3001/api`)

Vite dev server on port `3001` serves **two** API surfaces.
They look similar but differ in auth and ownership.

## Calling this API from an agent (read this first)

`npm run dev:https` puts the board behind a **self-signed** certificate
(Android mic requires HTTPS). That breaks most tooling in a way that is easy
to misdiagnose:

| Attempt | What happens |
| ------- | ------------ |
| `fetch("https://localhost:3001/...")` | `TypeError: self signed certificate` |
| `fetch("http://localhost:3001/...")` | socket closed / `Empty reply from server` |
| `Invoke-RestMethod -SkipCertificateCheck` | `NamedParameterNotFound` — that parameter is on `Invoke-WebRequest` (PowerShell 7.4+), **not** `Invoke-RestMethod` |

**Use the plain-HTTP bridge on port `3002`.** `npm run dev:https` starts it
automatically (`scripts/http-bridge.mjs`); it forwards to `3001` over whichever
transport that server is actually speaking and accepts WebSocket upgrades.

```js
// Node fetch — works with or without TLS on the board
await fetch("http://localhost:3002/api/kanban/tasks");
```

```powershell
# PowerShell — plain HTTP, no certificate flag needed
Invoke-RestMethod http://localhost:3002/api/kanban/tasks
```

```sh
curl.exe -sS http://localhost:3002/api/kanban/tasks     # preferred
curl.exe -k -sS https://localhost:3001/api/kanban/tasks  # direct, -k required
```

`GET /api/kanban/docs?format=json` reports the live answer in its `access`
field (`selfSigned`, `base`, `tips`) — it inspects the actual socket, so it is
never wrong. On plain HTTP (`npm run dev`) port `3001` works directly and no
bridge is needed.

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
  "allowedModels": ["ollama/gemma4:e2b", "openai/gpt-5"],
  "createdAt": "2026-10-09T12:07:17.765559+00:00"
}
```

`allowedModels[]` is the list of models usable in this project
(`providerID/modelID`, sourced from `GET /api/kanban/oc/model`).
An **empty** array means *no restriction* — every model the OpenCode server
offers is available. The list constrains which models can be picked for tasks
and sessions in this project; an explicit per-task model always wins at run time.

### `POST /api/kanban/projects`

Body: `name` required; optional `folder` (preferred) or legacy `path`
(must sit inside `KANBAN_PROJECTS_ROOT`), `gitUrl`, `gitBranch`,
`noMkdir`, `description`, `id`, `agentIds[]`, `allowedModels[]`
(`["providerID/modelID", …]`; omit or send `[]` for no restriction).

### `PATCH` / `PUT /api/kanban/projects/:id`

Optional `name`, `folder` (re-derives `path`) or `path`, `gitUrl`,
`gitBranch`, `description`, `agentIds[]`, `allowedModels[]`
(sends the whole list, replacing the stored one; `[]` clears the restriction,
omitting the field leaves it unchanged).

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

## Worktree isolation — `/api/kanban/tasks/:id/worktree`

Every task can run in its own **git worktree**. The agent session then works in
that folder, so two parallel tasks never share files, git index or build
output. The board merges the task branch into the project branch when the task
reaches `done`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/kanban/tasks/:id/worktree` | `{ taskId, path, branch, state, note }` |
| POST | `/api/kanban/tasks/:id/worktree` | create the worktree → `{ ok, path, branch, base, reused }` |
| POST | `/api/kanban/tasks/:id/worktree/merge` | merge the branch → `{ ok, merged, conflict, files[], error }` |
| DELETE | `/api/kanban/tasks/:id/worktree` | remove the worktree folder → `{ ok, removed, path, branch, error }` |

- Worktree folder: `<KANBAN_WORKTREES_ROOT>/<project folder>/<task id>`.
  Default root: `<KANBAN_PROJECTS_ROOT>/.kanban-worktrees`.
- Branch: `kanban/task-<first 8 chars of the task id>`.
- Base branch: the project branch (`projects.gitBranch`), or `HEAD` when that
  branch does not exist locally.
- `state`: `active` → `merged` | `conflict` | `pending` | `removed`.
- A failed merge never breaks the status change. The task keeps `done` and the
  board shows `worktreeState: "conflict"` plus the conflict note.
- Set `KANBAN_WORKTREE_AUTOMERGE=0` to switch the automatic merge off.
- Projects without a git repo keep the plain project folder.

CLI (same store, used by the plugin and the board):

```powershell
python server/kanban.py worktree create <taskId>
python server/kanban.py worktree merge  <taskId> [--target main] [--cleanup]
python server/kanban.py worktree remove <taskId> [--force] [--delete-branch]
python server/kanban.py worktree list   [--project <projectId>]
```

## Features — `/api/kanban/features`

A feature groups the steps of one unit of work. All its tasks share **one**
git worktree and **one** branch, so the steps build on each other.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/kanban/features?projectId=` | `Feature[]` — the features of a board |
| GET | `/api/kanban/features/:id` | `Feature` with its tasks |
| POST | `/api/kanban/features` | create a feature: worktree + branch. Body: `projectId*`, `title*`, `description?`, `base?` |
| POST | `/api/kanban/features/:id/merge` | merge the feature branch into the project branch. Body: `target?` |
| DELETE | `/api/kanban/features/:id` | delete the feature, remove its worktree. The tasks stay on the board |

- Worktree folder: `<KANBAN_WORKTREES_ROOT>/<project folder>/feature-<featureId>`.
- Branch: `kanban/feature-<first 8 chars of the feature id>`.
- `status`: `active` / `done`. `mergeNote` holds the last merge message.
- A task of a feature is created with `featureId`. Its row then carries the
  feature worktree path and branch.
- **The board never merges a feature by itself.** The `integrator` agent calls
  the merge. A task that reaches `done` does not merge the feature.
- Only one step of a feature may run at a time. The board refuses the second
  running step with `Feature worktree is busy`.

CLI:

```powershell
python server/kanban.py feature create --project <projectId> --title "Feature A"
python server/kanban.py feature list   [--project <projectId>]
python server/kanban.py feature show   <featureId>
python server/kanban.py feature merge  <featureId>
python server/kanban.py feature delete <featureId>
```

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
`modelProviderID`, `timeoutSec` (default 600,
cap 1800), `pollMs` (default 3000), `wait` (default true — false =
fire-and-forget, returns right after starting).

How it works: creates the subtask → flips it to `running` → spawns a session
in the project dir via the OpenCode server → sends the prompt (which tells the
teammate to finish with `PATCH …/tasks/:id {"status":"done"}`) → polls SQLite
until `done`/`blocked` or the timeout. Spawn/prompt failures park the subtask
as `blocked` with `startupError`. OpenCode URL and authentication come only
from `OPENCODE_SERVER_URL` and `OPENCODE_SERVER_PASSWORD` in the root `.env`.
**Give the client a generous `-TimeoutSec`** (≥ `timeoutSec`).

## Follow-up — `POST /api/kanban/message_to` (same session, no new task)

After a `delegate` returns, ask more **in the same subtask session** —
no new card, history preserved. Sends `text` to the existing session and
**waits for the next assistant message**, returning only that last message:

```powershell
$body = @{
  sessionId = "ses_abc123"   # from a delegate return — or pass taskId instead
  text      = "also list the files you read"
  timeoutSec = 120
} | ConvertTo-Json

Invoke-WebRequest http://localhost:3001/api/kanban/message_to `
  -Method POST -ContentType "application/json" -Body $body `
  -TimeoutSec 180 -UseBasicParsing |
  Select-Object -ExpandProperty Content
# → {"sessionId":"ses_abc123","taskId":"<subtask-uuid>","resultText":"README.md, docs/...","resultTruncated":false,"messageId":"msg_...","waited":true}
```

Body: `sessionId` **or** `taskId` (resolves via the task's `sessionId`) +
`text*`; optional `timeoutSec` (default 120,
cap 600), `pollMs` (default 1500). Only the **last assistant message** is
relevant — tool/reasoning frames are skipped, capped at 4000 chars
(`resultTruncated: true` when cut). Plugin tool: `kanban_message_to
{sessionId?|taskId?,text,...}`. Same OpenCode auth as delegate.

## Task prompt layers (`src/prompts/taskPrompt.ts`)

Every board task is told what to do in **three layers**. Only layer 3 repeats.

| Layer | Content | When |
| --- | --- | --- |
| 1. Agent instructions | The agent definition (`build`, `coder`, `testing`, …) | Loaded by OpenCode with the session |
| 2. Task-session instruction | Durable task contract: lifecycle, work method, delegation, security, communication, and the cyclical checkpoint protocol | **Once**, when the session is created |
| 3. Execution prompt | Title, description, priority, and cycle/checkpoint metadata | **Once per run** (and once per cycle) |

Layer 2 is stored as the instruction entry `task-agent`:

```http
PUT /api/kanban/oc/experimental/session/{sessionId}/instructions/entries/task-agent
{ "value": "<task-agent-preamble.md + task identity + work method>" }
```

Layer 3 is the only thing sent to `POST /session/{id}/prompt`:

```text
Execute this task now.

Task id: q-123
Session id: ses_abc
Title: Check email
Priority: High

## What to do
Summarize unread important messages.
```

A **cyclical** task reuses the same session. Layer 2 is written on the first
cycle only; every later cycle sends a short layer-3 message:

```text
Run the next cycle of this cyclical task.

Task id: q-123
Session id: ses_abc
Cycle time: 2026-10-17T10:00:00Z
Repeats: every 3600 seconds
Checkpoint file: .kanban/checkpoints/q-123.json
Title: Check email
Priority: High

## What to do
Summarize unread important messages.
```

If the instruction `PUT` fails, the board falls back to sending the full
contract inline (old behaviour), so the agent never runs without rules.

### Cyclical checkpoints

A cyclical task keeps its own checkpoint file in the project worktree:

```text
.kanban/checkpoints/<task-id>.json
```

The session instruction (layer 2) defines the protocol; the agent owns the file:

- read the file at the **start** of every cycle — the file is authoritative, not chat history;
- if missing, create it and treat the previous position as "last 24 hours";
- process only items **after** the stored checkpoint;
- write it **only after a successful cycle**;
- on failure leave it unchanged, so the next cycle retries;
- store cursors/ids/timestamps only — never secrets or message bodies.

`.kanban/checkpoints/` is git-ignored (runtime state, not source).

## Server — `GET /api/kanban/server`

Returns `{ url, hasPassword }` from the root `.env`. The endpoint never returns
the secret. Server settings are read-only in the browser.

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

## Plugin tool equivalents (`opencode-plugin/`)

Same SQLite rows, native plugin tools, actor recorded as `"agent"`:

| Plugin tool | HTTP equivalent |
| ----------- | --------------- |
| `kanban_update_status {taskId,status}` | `PATCH /api/kanban/tasks/:id {status}` |
| `kanban_create_task {projectId,title,...}` | `POST /api/kanban/tasks` |
| `kanban_update_task {taskId,...}` | `PATCH /api/kanban/tasks/:id` |
| `kanban_list_tasks {projectId?,status?}` | `GET /api/kanban/tasks?...` |
| `kanban_task_status {taskId?}` | `GET /api/kanban/tasks/:id` or `GET /api/kanban/events` |
| `kanban_delegate {projectId,title,...}` | `POST /api/kanban/delegate` — sync: create + run + WAIT for done |
| `kanban_message_to {sessionId?|taskId?,text,...}` | `POST /api/kanban/message_to` — follow-up in SAME session, returns last message |
| `kanban_worktree {action,taskId?}` | `POST/GET/DELETE /api/kanban/tasks/:id/worktree` — create, read, merge or remove the task worktree |
| `kanban_feature {action,featureId?}` | `POST/GET/DELETE /api/kanban/features/:id` — create, read, merge or delete the feature worktree |

Canonical reference: [`vite.config.js` `kanbanApi()`](../vite.config.js) (routes),
[`server/kanban.py`](../server/kanban.py) (store/CLI), [`README.md`](../README.md) (workflow).
