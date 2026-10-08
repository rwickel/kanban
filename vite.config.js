import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VALID_STATUSES = new Set(["backlog", "running", "done", "blocked"]);

// Shared queue with mcp-kanban/server.js (KANBAN_MCP_QUEUE env or %TEMP%/kanban-mcp).
// The agent calls the kanban_update_status MCP tool → queue file lands here →
// the browser polls GET /api/tasks/pending and applies the move.
const QUEUE_DIR = process.env.KANBAN_MCP_QUEUE || join(tmpdir(), "kanban-mcp");

function readQueueFiles() {
  const out = [];
  try {
    for (const f of readdirSync(QUEUE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push({ ...JSON.parse(readFileSync(join(QUEUE_DIR, f), "utf8")), file: f });
      } catch { /* skip corrupt */ }
    }
  } catch { /* dir missing — no pending */ }
  return out;
}

function clearQueueFiles() {
  try {
    for (const f of readdirSync(QUEUE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try { unlinkSync(join(QUEUE_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function kanbanTasksApi() {
  return {
    name: "kanban-tasks-api",
    configureServer(server) {
      // Registered before the "/api" proxy below, so /api/tasks/* is handled
      // here and never forwarded to the OpenCode server on :4096.
      server.middlewares.use("/api/tasks", (req, res, next) => {
        // connect strips the mount prefix: req.url is now "/<id>" or "/pending"
        const path = (req.url || "/").split("?")[0];
        const parts = path.split("/").filter(Boolean);

        // GET /api/tasks/pending → { pending: [{ taskId, status, at }] }
        // Reads the MCP queue dir (written by mcp-kanban/server.js).
        if (req.method === "GET" && parts.length === 1 && parts[0] === "pending") {
          const pending = readQueueFiles().map(({ file, ...rest }) => rest);
          return json(res, 200, { pending });
        }

        // DELETE /api/tasks/pending → clear queue (called by the app after applying)
        if (req.method === "DELETE" && parts.length === 1 && parts[0] === "pending") {
          clearQueueFiles();
          return json(res, 200, { ok: true });
        }

        return json(res, 404, { ok: false, error: "status updates come via the kanban MCP tool (kanban_update_status)" });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), kanbanTasksApi()],
  server: {
    host: "0.0.0.0",
    port: 3001,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4096",
    },
    hmr: {
      port: 3001,
    },
  },
});
