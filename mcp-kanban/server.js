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

// Agent → teammate: create a subtask, run it immediately, WAIT until done.
// Same contract as the HTTP POST /api/kanban/delegate — synchronous like read/write.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ocHeaders(pw) {
  if (!pw) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` };
}

server.registerTool(
  "kanban_delegate",
  {
    title: "Delegate task to a teammate (sync)",
    description:
      "Create a task for another agent on the team, execute it immediately, and WAIT until it finishes — returns the finished Task like a normal read/write tool call. Uses the project's agent team and shared kanban store; the subtask flips to done/blocked when the teammate is done. Prefer this over fire-and-forget create when you need the result.",
    inputSchema: {
      projectId: z.string().describe("Project uuid the subtask belongs to"),
      title: z.string().describe("Subtask title"),
      description: z.string().optional().describe("Subtask description / instructions for the teammate"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default medium)"),
      agentId: z.string().optional().describe("Teammate agent id (must be in the project's team). Omit to use the project's first team member."),
      agentName: z.string().optional(),
      modelId: z.string().optional(),
      modelProviderID: z.string().optional(),
      timeoutSec: z.number().optional().describe("Max seconds to wait for done/blocked (default 600, cap 1800)"),
      pollMs: z.number().optional().describe("Poll interval in ms (default 3000)"),
      wait: z.boolean().optional().describe("When false, fire-and-forget: return after creating/starting, don't wait"),
    },
  },
  async (args) => {
    const projectId = args.projectId;
    const title = args.title;
    const description = args.description || "";
    const priority = args.priority || "medium";
    const timeout = Math.min(Math.max(Number(args.timeoutSec) || 600, 30), 1800);
    const interval = Math.min(Math.max(Number(args.pollMs) || 3000, 1000), 15000);
    const shouldWait = args.wait !== false;

    const created = runCli(["task", "create", "--project", projectId, "--title", title, "--actor", "delegate",
      "--description", description, "--priority", priority,
      ...(args.agentId ? ["--agent-id", args.agentId] : []),
      ...(args.agentName ? ["--agent-name", args.agentName] : []),
      ...(args.modelId ? ["--model-id", args.modelId] : []),
      ...(args.modelProviderID ? ["--model-provider", args.modelProviderID] : []),
    ]);
    if (!created.ok) return { content: [{ type: "text", text: created.text }], isError: true };
    let tid;
    try { tid = JSON.parse(created.text).id; } catch { return { content: [{ type: "text", text: created.text }], isError: true }; }

    const moved = runCli(["task", "move", tid, "running", "--actor", "delegate"]);
    if (!moved.ok) return { content: [{ type: "text", text: moved.text }], isError: true };

    // Need the project's working directory for session.location.
    let projectPath = "";
    try {
      const pj = runCli(["project", "list", "--json"]);
      if (pj.ok) {
        const list = JSON.parse(pj.text);
        const row = Array.isArray(list) ? list.find((p) => p.id === projectId) : null;
        projectPath = row?.path || "";
      }
    } catch { /* best-effort */ }

    const base = (process.env.OPENCODE_SERVER_URL || "http://localhost:4096").replace(/\/+$/, "");
    const apiBase = base.endsWith("/api") ? base : `${base}/api`;
    const pw = process.env.OPENCODE_SERVER_PASSWORD || process.env.KANBAN_OPENCODE_PASSWORD || "";
    const H = { "Content-Type": "application/json", ...ocHeaders(pw) };

    try {
      const sessBody = {};
      if (args.agentId || args.agentName) sessBody.agent = args.agentId || args.agentName;
      if (args.modelId && args.modelProviderID) sessBody.model = { providerID: args.modelProviderID, id: args.modelId };
      if (projectPath) sessBody.location = { directory: projectPath };
      const sRes = await fetch(`${apiBase}/session`, { method: "POST", headers: H, body: JSON.stringify(sessBody) });
      if (!sRes.ok) throw new Error(`session create failed (HTTP ${sRes.status}) — ${(await sRes.text().catch(() => "")).slice(0, 300)}`);
      const sJson = await sRes.json();
      const session = sJson?.data ?? sJson;
      if (!session?.id) throw new Error("session create returned no id");
      const upd = runCli(["task", "update", tid, "--actor", "delegate", "--session-id", session.id,
        ...(args.agentId ? ["--agent-id", args.agentId] : []),
        ...(args.agentName ? ["--agent-name", args.agentName] : []),
        "--startup-phase", "ready"]);
      void upd;
      const prompt =
        `You are ${args.agentName || args.agentId || "a teammate"} executing a delegated subtask. Complete it end-to-end in ${projectPath || "the project"}.\n` +
        `Task id: ${tid}\nProject id: ${projectId}\nTask: ${title}\nDescription: ${description || "(none)"}\n\n` +
        `When finished, call kanban_update_status with { taskId: "${tid}", status: "done" } (or "blocked" if stuck). That flip is your return value — the delegating agent is waiting for it.`;
      const pRes = await fetch(`${apiBase}/session/${session.id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: prompt }) });
      if (!pRes.ok) throw new Error(`send prompt failed (HTTP ${pRes.status}) — ${(await pRes.text().catch(() => "")).slice(0, 300)}`);

      if (!shouldWait) {
        const cur = runCli(["task", "show", tid]);
        return { content: [{ type: "text", text: JSON.stringify({ task: cur.ok ? JSON.parse(cur.text) : cur.text, sessionId: session.id, waited: false }, null, 2) }] };
      }

      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        await sleep(interval);
        const cur = runCli(["task", "show", tid]);
        if (!cur.ok) continue;
        let row; try { row = JSON.parse(cur.text); } catch { continue; }
        if (row.status === "done" || row.status === "blocked") {
          return { content: [{ type: "text", text: JSON.stringify({ task: row, sessionId: session.id, waited: true }, null, 2) }] };
        }
        if (Date.now() >= deadline) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `delegate timed out after ${timeout}s — still ${row.status}`, task: row, sessionId: session.id }, null, 2) }], isError: true };
        }
      }
    } catch (e) {
      let cur = null;
      try {
        const u = runCli(["task", "update", tid, "--actor", "delegate", "--status", "blocked", "--startup-phase", "error", "--startup-error", String(e?.message || e).slice(0, 500)]);
        cur = u.ok ? JSON.parse(u.text) : null;
      } catch { /* */ }
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message || e), task: cur }, null, 2) }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
