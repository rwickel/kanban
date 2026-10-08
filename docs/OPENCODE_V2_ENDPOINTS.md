# OpenCode v2 HTTP API Endpoints

Source: https://opencode.ai/v2/docs/api/
OpenAPI JSON: https://opencode.ai/v2/openapi.json (141 operations, 256 schemas)

Base URL: `http://<host>:<port>/api` (default port `4096`)
Auth: HTTP Basic `opencode:<password>` (`OPENCODE_SERVER_PASSWORD`), or pairing token as password.
Envelope: most `GET` list/detail responses return `{ "location": {...}, "data": ... }`.

## server

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/info` | Server identity, URLs, paths, readiness |
| POST | `/api/pair` | Create short-lived pairing code |
| GET | `/auth/connect/{code}` | Redeem pairing code (cookie or JSON token) |

## location

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/location?directory=` | Resolve requested or default location |
| POST | `/api/location/reload` | Rebuild all loaded locations (204) |

## agent

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/agent?directory=` | List agents → `{ location, data: Agent.Info[] }` |
| GET | `/api/agent/{agentID}?directory=` | Single agent → `{ location, data: Agent.Info }` |

## plugin

| Method | Path | Body | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/api/plugin?directory=` | — | List plugins + status |
| POST | `/api/plugin/check` | `{ target? }` | Check plugin updates |
| POST | `/api/plugin/update` | `{ targets: string[] }` | Update plugins (204) |

## session

| Method | Path | Body / Query | Description |
| ------ | ---- | ------------ | ----------- |
| GET | `/api/session` | `?limit&order=asc\|desc&search&parentID&directory&project&subpath&cursor` | List sessions (paged, `SessionsResponse`) |
| POST | `/api/session` | `{ id?, parentID?, title?, agent?, model?, location?, metadata?, permissions? }` | Create session at location. Child via `parentID` → `{ data: Session.Info }` |
| GET | `/api/session/active` | — | Foreground drains owned by this process |
| GET | `/api/session/{sessionID}` | — | Get session → `{ data: Session.Info }` |
| PATCH | `/api/session/{sessionID}` | `{ title?, metadata?, permissions? }` | Update session (204) |
| DELETE | `/api/session/{sessionID}` | — | Delete + children (204) |
| POST | `/api/session/{sessionID}/fork` | `{ before? }` | Fork history into child → `{ data: Session.Info }` |
| POST | `/api/session/{sessionID}/agent` | `{ agent }` | Switch session agent |
| POST | `/api/session/{sessionID}/model` | `{ model }` | Switch session model |
| POST | `/api/session/{sessionID}/move` | `{ directory, delivery? }` | **Move session to another project directory (204)** |
| POST | `/api/session/{sessionID}/prompt` | `{ text, id?, files?, agents?, skills?, metadata?, delivery?, resume? }` **required: `text`** | **Send message, schedule agent loop** → `{ data: Session.Inbox.User }` |
| POST | `/api/session/{sessionID}/command` | `{ name, text, files?, agents?, skills?, delivery? }` | Run slash command (204) |
| POST | `/api/session/{sessionID}/synthetic` | `{ text / parts }` | Add synthetic message |
| POST | `/api/session/{sessionID}/shell` | `{ command, agent, model? }` | Run shell command |
| POST | `/api/session/{sessionID}/compact` | — | Compact session |
| POST | `/api/session/{sessionID}/interrupt` | — | Interrupt execution |
| POST | `/api/session/{sessionID}/background` | — | Background blocking tools |
| POST | `/api/session/{sessionID}/generate` | `{ ...context }` | Generate text from context |
| POST | `/api/session/{sessionID}/view` | — | Mark viewed / view session |
| GET | `/api/session/{sessionID}/message` | `?limit&order&cursor&type=user\|assistant\|system\|...` | **List messages → `SessionMessagesResponse`** |
| GET | `/api/session/{sessionID}/message/{messageID}` | — | Single message |
| GET | `/api/session/{sessionID}/context` | — | Session context |
| GET | `/api/session/{sessionID}/diff` | — | Diff session turns |
| GET | `/api/session/{sessionID}/inbox` | — | List inbox |
| PATCH | `/api/session/{sessionID}/inbox/{inboxID}` | — | Update inbox item |
| DELETE | `/api/session/{sessionID}/inbox/{inboxID}` | — | Cancel inbox input |
| POST | `/api/session/{sessionID}/revert/stage` | — | Stage revert |
| DELETE | `/api/session/{sessionID}/revert` | — | Clear staged revert |
| POST | `/api/session/{sessionID}/revert/commit` | — | Commit staged revert |
| GET | `/api/session/{sessionID}/permission` | — | List permission requests |
| POST | `/api/session/{sessionID}/permission` | — | Create permission request |
| GET | `/api/session/{sessionID}/permission/{requestID}` | — | Get permission request |
| POST | `/api/session/{sessionID}/permission/{requestID}/reply` | `{ reply: once\|always\|reject }` | Reply to permission |
| GET | `/api/session/{sessionID}/form` | — | List forms |
| POST | `/api/session/{sessionID}/form` | `Form.CreatePayload` | Create form |
| GET | `/api/session/{sessionID}/form/{formID}` | — | Get form |
| DELETE | `/api/session/{sessionID}/form/{formID}` | — | Cancel form |
| POST | `/api/session/{sessionID}/form/{formID}/reply` | `Form.Reply` | Reply to form |
| PUT | `/api/session/{sessionID}/environment` | — | Set session env |
| GET | `/api/experimental/session/stats` | `?from&to&project&timezone&tools` | Activity/usage stats |
| POST | `/api/experimental/session/import` | `{ info, messages, location? }` | Import transcript |
| GET | `/api/experimental/session/{sessionID}/export` | `?sanitize` | Export transcript |
| POST | `/api/experimental/session/{sessionID}/skill` | `{ id, resume? }` | Activate skill (204) |
| POST | `/api/experimental/session/{sessionID}/wait` | — | Wait for session |
| GET | `/api/experimental/session/{sessionID}/instructions/entries` | — | List instruction entries |
| PUT | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | — | Put instruction entry |
| DELETE | `/api/experimental/session/{sessionID}/instructions/entries/{key}` | — | Remove instruction entry |
| GET | `/api/experimental/session/{sessionID}/log` | — | Read session log |
| GET | `/api/experimental/session/{sessionID}/terminal/read` | — | Read controlled terminal |
| GET | `/api/experimental/session/{sessionID}/terminal` | — | Terminal info |
| POST | `/api/experimental/session/{sessionID}/terminal` | — | Create terminal |

## model / generate / provider

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/model` | List models |
| GET | `/api/model/default` | Default model |
| POST | `/api/experimental/generate` | One-shot text generation |
| GET | `/api/provider` | List providers |
| GET | `/api/provider/{providerID}` | Single provider |

## integration

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/integration` | List integrations |
| GET | `/api/integration/{integrationID}` | Single integration |
| POST | `/api/experimental/integration/wellknown` | Add wellknown integration |
| POST | `/api/integration/{integrationID}/connect/key` | Connect with key |
| POST | `/api/integration/{integrationID}/connect/oauth` | Begin OAuth |
| GET | `/api/integration/{integrationID}/connect/oauth/{attemptID}` | OAuth status |
| DELETE | `/api/integration/{integrationID}/connect/oauth/{attemptID}` | Cancel OAuth |
| POST | `/api/integration/{integrationID}/connect/oauth/{attemptID}/complete` | Complete OAuth |
| POST | `/api/integration/{integrationID}/connect/command` | Begin command connection |
| GET | `/api/integration/{integrationID}/connect/command/{attemptID}` | Command status |
| DELETE | `/api/integration/{integrationID}/connect/command/{attemptID}` | Cancel command |

## mcp

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/mcp` | List MCP servers |
| PUT | `/api/experimental/mcp/{server}` | Add MCP server |
| DELETE | `/api/experimental/mcp/{server}` | Remove MCP server |
| POST | `/api/experimental/mcp/{server}/connect` | Connect |
| POST | `/api/experimental/mcp/{server}/disconnect` | Disconnect |
| GET | `/api/mcp/resource` | List MCP resources |

## credential

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/credential` | List credentials |
| POST | `/api/credential` | Create credential |
| PATCH | `/api/credential/{credentialID}` | Update credential |
| DELETE | `/api/credential/{credentialID}` | Remove credential |
| POST | `/api/credential/{credentialID}/activate` | Activate credential |

## project

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/project` | List projects |
| PATCH | `/api/project/{projectID}` | Update project |

## form / permission (global)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/form` | Pending location forms |
| GET | `/api/permission/request` | Pending permission requests |
| GET | `/api/permission/saved` | Saved permissions |
| DELETE | `/api/permission/saved/{id}` | Remove saved permission |

## filesystem

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/fs/read/*` | Read file |
| GET | `/api/fs/list` | List directory |
| GET | `/api/fs/find` | Find files |
| POST | `/api/experimental/fs/write` | Write file |

## command / skill / rpc / event

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/command` | List commands |
| GET | `/api/skill` | List skills |
| POST | `/api/rpc/{rpcID}/{method}` | Plugin RPC call |
| GET | `/api/event` | SSE event stream |

## pty / persistentPty / shell

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/pty` | List PTY sessions |
| POST | `/api/pty` | Create PTY |
| GET | `/api/pty/{ptyID}` | Get PTY |
| PUT | `/api/pty/{ptyID}` | Update PTY |
| DELETE | `/api/pty/{ptyID}` | Remove PTY |
| POST | `/api/pty/{ptyID}/connect-token` | WS token |
| GET | `/api/pty/{ptyID}/connect` | Connect PTY |
| POST | `/api/experimental/persistent-pty/shutdown` | Shutdown |
| POST | `/api/experimental/persistent-pty/handoff` | Handoff |
| GET | `/api/experimental/persistent-pty/{ptyID}` | Get |
| PUT | `/api/experimental/persistent-pty/{ptyID}` | Update |
| DELETE | `/api/experimental/persistent-pty/{ptyID}` | Remove |
| GET | `/api/experimental/persistent-pty/{ptyID}/snapshot` | Snapshot |
| POST | `/api/experimental/persistent-pty/{ptyID}/connect-token` | WS token |
| GET | `/api/experimental/persistent-pty/{ptyID}/connect` | Connect |
| GET | `/api/shell` | List running shells |
| POST | `/api/shell` | Run shell |
| GET | `/api/shell/{id}` | Get shell |
| DELETE | `/api/shell/{id}` | Remove shell |
| GET | `/api/shell/{id}/output` | Shell output |

## reference / worktree / vcs / debug / websearch / config

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/reference` | Project references |
| GET | `/api/worktree` | List worktrees |
| POST | `/api/worktree` | Create worktree |
| DELETE | `/api/worktree` | Remove worktree |
| POST | `/api/worktree/refresh` | Refresh worktrees |
| POST | `/api/vcs/init` | Init VCS repo |
| GET | `/api/vcs` | VCS info |
| GET | `/api/vcs/base` | Review base |
| GET | `/api/vcs/status` | VCS status |
| GET | `/api/vcs/branch` | Branches |
| GET | `/api/vcs/diff` | VCS diff |
| GET | `/api/debug/location` | Loaded locations |
| DELETE | `/api/debug/location` | Evict location |
| GET | `/api/experimental/migration/v1` | V1 migration status |
| GET | `/api/websearch/provider` | Search providers |
| POST | `/api/websearch` | Web search |
| GET | `/api/config` | Configuration |
| GET | `/api/config/shell` | Available shells |
| PATCH | `/api/experimental/config` | Update global config |

## Kanban usage (correct v2 shapes)

```ts
// create — location defaults to server cwd; pass location for /work vs subdir
POST /api/session
{ "title": "task title", "agent": "coder" }
// → { "data": { "id": "ses_...", ... } }

// send — required field is `text`, agents array uses AgentAttachment objects
POST /api/session/{id}/prompt
{ "text": "title\n\ndescription", "agents": [{ "name": "coder" }] }
// → { "data": { ...inbox user... } }

// read
GET /api/session/{id}/message?limit=50&order=asc
// → { "data": [ { "info": {...}, "parts": [...] } ], "cursor": {...} }

// fix wrong directory
POST /api/session/{id}/move
{ "directory": "/work" }
```

Notes:
- `POST /session` has no `directory` field — use `location: { directory }` on create or `POST /session/{id}/move` after.
- `POST /session/{id}/prompt` takes `text` (not `message`/`parts`) and `agents: [{name}]` (not `agent: "id"` string).
- `GET /session/{id}/message` returns paged `{ data, cursor }`, not a bare array.
