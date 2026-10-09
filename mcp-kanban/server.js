// kanban-mcp: local MCP server (stdio) — Option B.
// Owns task logic + storage via server/kanban.py (SQLite, uuid model).
// No queue files, no browser dependency. All tools hit the shared DB
// synchronously and return the row JSON, so agents get ids back.
//
// Shared DB (Docker sees it via C:/Users/Robert/work:/work):
//   host:      <repo>/.kanban-data/kanban.db
//   container: /work/kanban-clone/.kanban-data/kanban.db
// Env override: KANBAN_DB (file) or KANBAN_DATA_DIR (dir).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "server", "kanban.py");

const DB =
  process.env.KANBAN_DB ||
  join(process.env.KANBAN_DATA_DIR || join(REPO, ".kanban-data"), "kanban.db");

const PYTHON = process.env.KANBAN_PYTHON || "python";

function runCli(argv) {
  try {
    const out = execFileSync(PYTHON, [CLI, "--db", DB, ...argv], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { ok: true, text: (out || "").trim() };
  } catch (err) {
    const msg =
      err?.stderr?.toString?.() || err?.message || "kanban CLI failed";
    return { ok: false, text: String(msg).trim() };
  }
}

function toolResult(res) {
  if (res.ok) return { content: [{ type: "text", text: res.text || "{}" }] };
  return { content: [{ type: "text", text: res.text }], isError: true };
}

if (!existsSync(CLI)) {
  console.error(`kanban CLI not found: ${CLI}`);
}

const server = new McpServer({ name: "kanban", version: "2.0.0" });

server.registerTool(
  "kanban_update_status",
  {
    title: "Update kanban task status",
    description:
      "Move a kanban task to a new status. Call with status 'done' when complete, 'blocked' if stuck. Writes directly to the shared SQLite store.",
    inputSchema: {
      taskId: z.string().describe("Kanban task id (uuid, from the Task id in your prompt)"),
      status: z.enum(["backlog", "running", "done", "blocked"]).describe("New status"),
    },
  },
  async ({ taskId, status }) => toolResult(runCli(["task", "move", taskId, status, "--actor", "agent"]))
);

server.registerTool(
  "kanban_create_task",
  {
    title: "Create kanban task",
    description: "Create a new task in a project's backlog. Returns the created task JSON including its uuid.",
    inputSchema: {
      projectId: z.string().describe("Project uuid the task belongs to"),
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default medium)"),
    },
  },
  async ({ projectId, title, description, priority }) => {
    const argv = ["task", "create", "--project", projectId, "--title", title, "--actor", "agent"];
    if (description) argv.push("--description", description);
    if (priority) argv.push("--priority", priority);
    return toolResult(runCli(argv));
  }
);

server.registerTool(
  "kanban_update_task",
  {
    title: "Update kanban task",
    description: "Patch title/description/priority/agent/session fields of a task. Returns updated task JSON.",
    inputSchema: {
      taskId: z.string().describe("Kanban task id (uuid)"),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    },
  },
  async ({ taskId, title, description, priority }) => {
    const argv = ["task", "update", taskId, "--actor", "agent"];
    if (title !== undefined) argv.push("--title", title);
    if (description !== undefined) argv.push("--description", description);
    if (priority !== undefined) argv.push("--priority", priority);
    if (argv.length <= 3) {
      return { content: [{ type: "text", text: "nothing to update" }], isError: true };
    }
    return toolResult(runCli(argv));
  }
);

server.registerTool(
  "kanban_list_tasks",
  {
    title: "List kanban tasks",
    description: "List tasks from the shared store, optionally filtered by project and/or status.",
    inputSchema: {
      projectId: z.string().optional().describe("Project uuid filter"),
      status: z.enum(["backlog", "running", "done", "blocked"]).optional(),
    },
  },
  async ({ projectId, status }) => {
    const argv = ["task", "list"];
    if (projectId) argv.push("--project", projectId);
    if (status) argv.push("--status", status);
    return toolResult(runCli(argv));
  }
);

server.registerTool(
  "kanban_task_status",
  {
    title: "Show kanban task",
    description: "Show one task by id (replaces the old pending-queue listing).",
    inputSchema: {
      taskId: z.string().optional().describe("Task uuid. If omitted, lists recent events instead."),
    },
  },
  async ({ taskId }) => {
    if (taskId) return toolResult(runCli(["task", "show", taskId]));
    return toolResult(runCli(["events", "list", "--limit", "20"]));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
