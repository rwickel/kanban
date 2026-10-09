import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const VALID_STATUSES = new Set(["backlog", "running", "done", "blocked"]);

// Load .env so KANBAN_* vars are available without restarting the shell.
(() => {
  const p = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const k = t.slice(0, t.indexOf("=")).trim();
    const v = t.slice(t.indexOf("=") + 1).trim();
    if (k && v && !process.env[k]) process.env[k] = v;
  }
})();

// Option B: SQLite store owned by server/kanban.py (uuid model).
// Shared file so host, Vite, MCP, and Docker see the same truth:
//   host:      <repo>/.kanban-data/kanban.db
//   container: /work/kanban-clone/.kanban-data/kanban.db
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "server", "kanban.py");
const DB =
  process.env.KANBAN_DB ||
  join(process.env.KANBAN_DATA_DIR || join(HERE, ".kanban-data"), "kanban.db");
const PYTHON = process.env.KANBAN_PYTHON || "python";

async function cli(args) {
  const { stdout } = await execFileAsync(PYTHON, [CLI, "--db", DB, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse((stdout || "null").trim() || "null");
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function kanbanApi() {
  return {
    name: "kanban-api",
    configureServer(server) {
      // Before the "/api" proxy: /api/kanban/* is the local store,
      // everything else under /api still forwards to OpenCode :4096.
      server.middlewares.use("/api/kanban", async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const parts = url.pathname.split("/").filter(Boolean);
        const q = url.searchParams;
        try {
          // GET /api/kanban/tasks?projectId=&status=  → Task[]
          if (req.method === "GET" && parts[0] === "tasks" && parts.length === 1) {
            const argv = ["task", "list"];
            if (q.get("projectId")) argv.push("--project", q.get("projectId"));
            if (q.get("status")) {
              if (!VALID_STATUSES.has(q.get("status")))
                return json(res, 400, { ok: false, error: "invalid status" });
              argv.push("--status", q.get("status"));
            }
            return json(res, 200, await cli(argv));
          }
          // GET /api/kanban/tasks/:id → Task
          if (req.method === "GET" && parts[0] === "tasks" && parts.length === 2) {
            return json(res, 200, await cli(["task", "show", parts[1]]));
          }
          // POST /api/kanban/tasks {projectId,title,...} → Task
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 1) {
            const b = await readBody(req);
            if (!b.projectId || !b.title)
              return json(res, 400, { ok: false, error: "projectId and title required" });
            const argv = ["task", "create", "--project", b.projectId, "--title", b.title, "--actor", "board"];
            if (b.description) argv.push("--description", b.description);
            if (b.status) argv.push("--status", b.status);
            if (b.priority) argv.push("--priority", b.priority);
            if (b.id) argv.push("--id", b.id);
            if (b.agentId) argv.push("--agent-id", b.agentId);
            if (b.agentName) argv.push("--agent-name", b.agentName);
            if (b.sessionId) argv.push("--session-id", b.sessionId);
            if (b.modelId) argv.push("--model-id", b.modelId);
            if (b.modelProviderID) argv.push("--model-provider", b.modelProviderID);
            if (b.startupPhase) argv.push("--startup-phase", b.startupPhase);
            if (b.startupError !== undefined) argv.push("--startup-error", b.startupError || "");
            return json(res, 200, await cli(argv));
          }
          // PATCH /api/kanban/tasks/:id {title?,status?,...} → Task
          if (req.method === "PATCH" && parts[0] === "tasks" && parts.length === 2) {
            const b = await readBody(req);
            const argv = ["task", "update", parts[1], "--actor", "board"];
            for (const [flag, key] of [
              ["--title", "title"], ["--description", "description"],
              ["--status", "status"], ["--priority", "priority"],
              ["--agent-id", "agentId"], ["--agent-name", "agentName"],
              ["--session-id", "sessionId"], ["--model-id", "modelId"],
              ["--model-provider", "modelProviderID"],
              ["--startup-phase", "startupPhase"], ["--startup-error", "startupError"],
            ]) {
              if (b[key] !== undefined && b[key] !== null) argv.push(flag, String(b[key]));
            }
            return json(res, 200, await cli(argv));
          }
          // DELETE /api/kanban/tasks/:id → {ok:true}
          if (req.method === "DELETE" && parts[0] === "tasks" && parts.length === 2) {
            return json(res, 200, await cli(["task", "delete", parts[1], "--actor", "board"]));
          }
          // GET /api/kanban/projects → Project[]
          if (req.method === "GET" && parts[0] === "projects" && parts.length === 1) {
            return json(res, 200, await cli(["project", "list", "--json"]));
          }
          // POST /api/kanban/projects {name,folder,path?,gitUrl?,gitBranch?,description,id?} → Project
          if (req.method === "POST" && parts[0] === "projects" && parts.length === 1) {
            const b = await readBody(req);
            if (!b.name) return json(res, 400, { ok: false, error: "name required" });
            const argv = ["project", "create", "--name", b.name, "--actor", "board"];
            if (b.folder) argv.push("--folder", b.folder);
            else if (b.path) argv.push("--path", b.path);
            if (b.gitUrl) argv.push("--git-url", b.gitUrl);
            if (b.gitBranch) argv.push("--git-branch", b.gitBranch);
            if (b.noMkdir) argv.push("--no-mkdir");
            if (b.description) argv.push("--description", b.description);
            if (b.id) argv.push("--id", b.id);
            for (const a of b.agentIds || []) argv.push("--agent-id", a);
            return json(res, 200, await cli(argv));
          }
          // PATCH /api/kanban/projects/:id {name?,folder?,path?,gitUrl?,gitBranch?,description?,agentIds?} → Project
          if ((req.method === "PATCH" || req.method === "PUT") && parts[0] === "projects" && parts.length === 2) {
            const b = await readBody(req);
            const argv = ["project", "update", parts[1], "--actor", "board"];
            if (b.name !== undefined) argv.push("--name", String(b.name));
            if (b.folder !== undefined) argv.push("--folder", String(b.folder));
            else if (b.path !== undefined) argv.push("--path", String(b.path));
            if (b.gitUrl !== undefined) argv.push("--git-url", String(b.gitUrl || ""));
            if (b.gitBranch !== undefined) argv.push("--git-branch", String(b.gitBranch || "main"));
            if (b.description !== undefined) argv.push("--description", String(b.description));
            for (const a of b.agentIds || []) argv.push("--agent-id", a);
            return json(res, 200, await cli(argv));
          }
          // DELETE /api/kanban/projects/:id → {ok:true}
          if (req.method === "DELETE" && parts[0] === "projects" && parts.length === 2) {
            return json(res, 200, await cli(["project", "delete", parts[1], "--actor", "board"]));
          }
          // GET /api/kanban/roots → { root, folders }
          if (req.method === "GET" && parts[0] === "roots" && parts.length === 1) {
            return json(res, 200, await cli(["folders", "list", "--json"]));
          }
          // GET /api/kanban/folders → folders under PROJECTS_ROOT
          if (req.method === "GET" && parts[0] === "folders" && parts.length === 1) {
            return json(res, 200, await cli(["folders", "list", "--json"]));
          }
          // GET /api/kanban/folders/:name/git → git info
          if (req.method === "GET" && parts[0] === "folders" && parts.length === 3 && parts[2] === "git") {
            return json(res, 200, await cli(["folders", "git", parts[1]]));
          }
          // GET /api/kanban/projects/:id/git-check → branch == pinned?
          if (req.method === "GET" && parts[0] === "projects" && parts.length === 3 && parts[2] === "git-check") {
            return json(res, 200, await cli(["folders", "check", parts[1]]));
          }
          // POST /api/kanban/clone {url, folder, branch?} → git clone into root
          if (req.method === "POST" && parts[0] === "clone" && parts.length === 1) {
            const b = await readBody(req);
            if (!b.url || !b.folder) return json(res, 400, { ok: false, error: "url and folder required" });
            const argv = ["folders", "clone", b.url, "--folder", b.folder];
            if (b.branch) argv.push("--branch", b.branch);
            return json(res, 200, await cli(argv));
          }
          // GET /api/kanban/events?task=&limit= → Event[]
          if (req.method === "GET" && parts[0] === "events" && parts.length === 1) {
            const argv = ["events", "list", "--limit", q.get("limit") || "50"];
            if (q.get("task")) argv.push("--task", q.get("task"));
            return json(res, 200, await cli(argv));
          }
          return json(res, 404, { ok: false, error: "unknown kanban route" });
        } catch (err) {
          const msg = String(err?.stderr || err?.message || err);
          // Only map missing DB rows to 404 — git stderr often contains
          // "Repository not found", which is a 500 (clone failed), not a
          // missing route. Mapping it to 404 masks the real git error.
          if (/(project|task) not found/i.test(msg)) return json(res, 404, { ok: false, error: msg });
          return json(res, 500, { ok: false, error: msg });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), kanbanApi()],
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
