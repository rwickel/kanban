# kanban
Kanban Board Opencode Agent

## Workflow: kanban task -> opencode agent -> kanban task

Option B — the MCP server owns storage (SQLite). The browser is a thin
client. No queue files, no localStorage truth.

```
+----------------+   HTTP   +----------------+   CLI   +----------------+
|    Browser     |<-------->|  Vite /api/    |<------->| .kanban-data/  |
|    React       |          |  kanban/*      |         | kanban.db      |
|  (thin client) |          |  (CRUD over    |         | (SQLite, uuid  |
+-------+--------+          |  kanban.py)    |         |  model)        |
        |                   +-------+--------+         +-------+--------+
        | creates session                   CLI                 ^ CLI
        | + sends prompt                      \                 |
        v                                      \                | MCP tools
+----------------+                              \               | (stdio)
| OpenCode :4096 |                               \      +-------+--------+
| /api/session   |                                \     |  MCP server    |
| /api/.../prompt|                                 \    |  mcp-kanban/   |
+----------------+                                  \   |  server.js     |
                                                     \  +-------+--------+
                                                      \         | called by
                                                       \       v
                                                        \ +---------------+
                                                         \| opencode agent|
                                                          | (has taskId + |
                                                          |  projectId)  |
                                                          +---------------+
```

### 1. kanban task -> opencode agent (App.tsx: startTaskExecution)

Drag card to `running`:

```
user drops card
  -> resolveAgentForTask() ......... agent id/name
  -> POST /api/session ............. createSession({title, agent, model, directory})
  -> PATCH /api/kanban/tasks/:id ... pin {sessionId, agentId} to SQLite
  -> POST /api/session/:id/prompt .. sendPrompt(buildTaskPrompt(task))
  -> open SessionChatWindow ........ live feed + reply box
```

`buildTaskPrompt()` embeds `Task id` + `Project id` and instructs the
agent to call back via MCP tools when done (done/blocked), to split
follow-ups (kanban_create_task), and to search first (kanban_list_tasks).

### 2. Shared store (server/kanban.py)

Single SQLite file `.kanban-data/kanban.db`, shared with Docker via the
`/work` bind mount (`KANBAN_DB` / `KANBAN_DATA_DIR` override).

```
projects (id=uuid, name, path, description, agent_ids JSON)
tasks    (id=uuid, project_id=uuid, title, description,
          status=backlog|running|done|blocked,
          priority=low|medium|high|critical,
          agent_id, agent_name, session_id, model_*, timestamps)
events   (ts, task_id, actor, action, details) -- audit log
```

CLI prints row JSON: `task create|list|show|update|move|delete`,
`project create|list`, `events list`.

### 3. opencode agent -> kanban task (mcp-kanban/server.js)

stdio MCP, every tool runs `kanban.py` against the same DB and returns
row JSON synchronously (agent gets the id back):

```
kanban_update_status {taskId, status} ... task move ......... done/blocked at end
kanban_create_task {projectId, ...} . task create ....... split / follow-up work
kanban_update_task {taskId, ...} .... task update ....... patch title/desc/priority
kanban_list_tasks {projectId?, ...} . task list ......... search before creating
kanban_task_status {taskId?} ........ task show|events .. inspect
```

### 4. Browser reads (vite.config.js + store/kanban.ts)

```
Vite kanbanApi() ......... /api/kanban/tasks|projects|events (before :4096 proxy)
store/kanban.ts .......... async HTTP client, localStorage = offline cache only
App.tsx loadData() ....... GET store on start/switch/mutation + 5s refresh timer
```

Agent writes appear on the board within ~5s, no browser action needed.

### End-to-end example

```
1. User drags card -> running -> session ses_abc created, prompt sent (Task id: 428d...)
2. Agent codes, calls kanban_create_task({projectId, title:"Add tests"}) -> new uuid back
3. Agent calls kanban_update_status({taskId:"428d...", status:"done"}) -> SQLite row flips
4. Browser 5s refresh -> card moves to Complete, new card appears in Backlog
```
