// kanban-mcp: local MCP server (stdio) exposing kanban task-status tools.
// State bridge: the board owns tasks in browser localStorage; the agent and the
// browser can't talk directly, so this server appends status requests to a
// queue file. The kanban app polls the queue file and applies the moves.
//
// Queue dir: %TEMP%/kanban-mcp (or $KANBAN_MCP_QUEUE). Files: <taskId>.<status>.json
// Watchdog: the app's /api/tasks/pending poll reads this dir in dev; in prod
// builds the same files are picked up by the board poller.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QUEUE_DIR = process.env.KANBAN_MCP_QUEUE || join(tmpdir(), "kanban-mcp");
mkdirSync(QUEUE_DIR, { recursive: true });

const VALID = ["backlog", "running", "done", "blocked"];

const server = new McpServer({
  name: "kanban",
  version: "1.0.0",
});

server.registerTool(
  "kanban_update_status",
  {
    title: "Update kanban task status",
    description:
      "Move a kanban task to a new status. Call with status 'done' when the task is finished, 'blocked' when stuck. The board updates within seconds.",
    inputSchema: {
      taskId: z.string().describe("Kanban task id (from the Task id in your prompt)"),
      status: z.enum(["backlog", "running", "done", "blocked"]).describe("New status"),
    },
  },
  async ({ taskId, status }) => {
    if (!VALID.includes(status)) {
      return { content: [{ type: "text", text: `invalid status: ${status}` }], isError: true };
    }
    const file = join(QUEUE_DIR, `${taskId}.${status}.json`);
    writeFileSync(file, JSON.stringify({ taskId, status, at: new Date().toISOString() }));
    return {
      content: [{ type: "text", text: `Task ${taskId} → ${status} (board will update shortly)` }],
    };
  }
);

server.registerTool(
  "kanban_task_statuses",
  {
    title: "List pending kanban status updates",
    description: "List status updates queued by agents but not yet applied by the board.",
    inputSchema: {},
  },
  async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const out = [];
    for (const f of readdirSync(QUEUE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf8")));
      } catch { /* skip */ }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
