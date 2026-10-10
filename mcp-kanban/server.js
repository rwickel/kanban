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

// Server creds: from MCP config environment (OPENCODE_SERVER_URL +
// OPENCODE_SERVER_PASSWORD in opencode.json). No file loading, no fallbacks.
function loadMcpCreds() {
  return {
    url: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4099",
    password: process.env.OPENCODE_SERVER_PASSWORD ?? process.env.KANBAN_OPENCODE_PASSWORD ?? "",
  };
}

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
    title: "Delegate task to a teammate",
    description:
      "Create a task for another agent on the team and start it immediately. Fire-and-forget by default — returns { task, sessionId, waited:false } right away so the caller can fan out. Pass wait:true to block until done/blocked (like a sync read). Uses the project's agent team and shared kanban store; the subtask flips to done/blocked when the teammate is done.",
    inputSchema: {
      projectId: z.string().describe("Project uuid the subtask belongs to"),
      title: z.string().describe("Subtask title"),
      description: z.string().optional().describe("Subtask description / instructions for the teammate"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default medium)"),
      agentId: z.string().optional().describe("Teammate agent id (must be in the project's team). Omit to use the project's first team member."),
      agentName: z.string().optional(),
      modelId: z.string().optional(),
      modelProviderID: z.string().optional(),
      timeoutSec: z.number().optional().describe("Max seconds to wait for done/blocked when wait:true (default 600, cap 1800)"),
      pollMs: z.number().optional().describe("Poll interval in ms when wait:true (default 3000)"),
      wait: z.boolean().optional().describe("When true, WAIT until done/blocked before returning. Default false (fire-and-forget)."),
    },
  },
  async (args) => {
    const projectId = args.projectId;
    const title = args.title;
    const description = args.description || "";
    const priority = args.priority || "medium";
    const timeout = Math.min(Math.max(Number(args.timeoutSec) || 600, 30), 1800);
    const interval = Math.min(Math.max(Number(args.pollMs) || 3000, 1000), 15000);
    const shouldWait = args.wait === true;

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

    const creds = loadMcpCreds();
    const base = (creds.url || "http://127.0.0.1:4099").replace(/\/+$/, "");
    const apiBase = base.endsWith("/api") ? base : `${base}/api`;
    const pw = creds.password ?? "";
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
        `When finished, call kanban_update_status with { taskId: "${tid}", status: "done" } (or "blocked" if stuck). Fire-and-forget: the delegator already returned and will poll your status. Call kanban_task_heartbeat on your task id every couple of minutes with --progress so the watchdog sees you alive.`;
      const pRes = await fetch(`${apiBase}/session/${session.id}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text: prompt }) });
      if (!pRes.ok) throw new Error(`send prompt failed (HTTP ${pRes.status}) — ${(await pRes.text().catch(() => "")).slice(0, 300)}`);

      if (!shouldWait) {
        const cur = runCli(["task", "show", tid]);
        return { content: [{ type: "text", text: JSON.stringify({ task: cur.ok ? JSON.parse(cur.text) : cur.text, sessionId: session.id, waited: false }, null, 2) }] };
      }

      const deadline = Date.now() + timeout * 1000;
      let lastStuckNotifiedAt = 0;
      for (;;) {
        await sleep(interval);
        const cur = runCli(["task", "show", tid]);
        if (!cur.ok) continue;
        let row; try { row = JSON.parse(cur.text); } catch { continue; }
        if (row.status === "done" || row.status === "blocked") {
          return { content: [{ type: "text", text: JSON.stringify({ task: row, sessionId: session.id, waited: true }, null, 2) }] };
        }
        // Wedged tool detection (e.g. msg_1259... shell dir /a running w/o completed).
        // If a tool stayed `running` >90s, interrupt the session, prompt STOP, and park the task as blocked.
        // Services (npm run dev, vite, docker up) are NOT affected: their start tool returns `completed`
        // promptly and the process stays alive — so no running tool survives to be flagged.
        try {
          const list = await ocMessages(apiBase, H, session.id, 15);
          const last = ocLastAssistant(list);
          const stuck = last?.raw ? findStuckTool(last.raw, 90000) : null;
          if (stuck && stuck.ageMs > 90000 && Date.now() - lastStuckNotifiedAt > 120000) {
            lastStuckNotifiedAt = Date.now();
            const msg = `stalled: tool '${stuck.name}' running for ${Math.round(stuck.ageMs / 1000)}s without completion`;
            await ocInterrupt(apiBase, H, session.id);
            await ocPromptStop(apiBase, H, session.id);
            const updStall = runCli(["task", "update", tid, "--actor", "watchdog",
              "--status", "blocked", "--startup-phase", "error", "--startup-error", msg.slice(0, 500)]);
            void updStall;
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg, task: { id: tid, status: "blocked", stuckTool: stuck }, sessionId: session.id, stalled: true }, null, 2) }],
              isError: true,
            };
          }
        } catch { /* ocMessages may 401/404 while session spins — ignore */ }
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

// Agent → same-session follow-up: send text to an existing subtask session,
// WAIT for the next assistant message, return its text (no new task).
function ocBase() {
  const b = (loadMcpCreds().url || "http://127.0.0.1:4099").replace(/\/+$/, "");
  return b.endsWith("/api") ? b : `${b}/api`;
}
function ocH() {
  const pw = loadMcpCreds().password ?? "";
  return { "Content-Type": "application/json", ...ocHeaders(pw) };
}
async function ocMessages(apiBase, H, sessionId, limit = 30) {
  const r = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=desc`, { headers: H });
  if (!r.ok) throw new Error(`fetch messages failed (HTTP ${r.status})`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j?.data ?? []);
  return Array.isArray(list) ? list : [];
}
function ocMsgText(m) {
  if (!m || typeof m !== "object") return "";
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (m.info && typeof m.info.text === "string" && m.info.text.trim()) return m.info.text.trim();
  const pool = [...(Array.isArray(m.content) ? m.content : []), ...(Array.isArray(m.parts) ? m.parts : [])];
  return pool.filter((p) => p && typeof p === "object" && String(p.type || "").toLowerCase() === "text" && typeof p.text === "string" && p.text.trim()).map((p) => p.text.trim()).join("\n").trim();
}
function ocMsgRole(m) {
  if (!m || typeof m !== "object") return "";
  for (const k of ["role", "type"]) if (typeof m[k] === "string" && ["assistant", "agent", "ai", "user", "system"].includes(m[k].toLowerCase())) return m[k].toLowerCase();
  if (m.info && typeof m.info.role === "string") return m.info.role.toLowerCase();
  return "";
}
function ocLastAssistant(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (ocMsgRole(m) === "user" || ocMsgRole(m) === "system") continue;
    const t = ocMsgText(m);
    if (t) return { text: t, id: m.id ?? m.messageID ?? null, raw: m };
  }
  return { text: "", id: null, raw: null };
}

// Stall helpers: detect a wedged tool call inside the last assistant message.
// Shape (v2): message.content[] entries {type:"tool", state:{status:"running"|"completed"}, time:{ran, completed?}, name, id}
// A tool with ran>stallMs ago and no completed timestamp = stuck (NOT a healthy `npm run dev` service:
// a service returns completed promptly and keeps the PROCESS alive, not the tool call).
function toolTimeMs(t) {
  if (t == null) return null;
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}
// Return {name, id, ageMs} of the oldest stuck running tool, or null.
function findStuckTool(msg, stallMs = 90000) {
  if (!msg || typeof msg !== "object") return null;
  const pool = [...(Array.isArray(msg.content) ? msg.content : []), ...(Array.isArray(msg.parts) ? msg.parts : [])];
  const now = Date.now();
  let oldest = null;
  for (const p of pool) {
    if (!p || typeof p !== "object") continue;
    if (String(p.type || "").toLowerCase() !== "tool") continue;
    const st = p.state || {};
    if (String(st.status || "").toLowerCase() !== "running") continue;
    // completed marker anywhere means it finished — skip.
    if (toolTimeMs(p?.time?.completed) || toolTimeMs(st.completed) || toolTimeMs(st.completedAt)) continue;
    const ran = toolTimeMs(p?.time?.ran) ?? toolTimeMs(st.ran) ?? toolTimeMs(p?.time?.created) ?? toolTimeMs(st.created);
    if (ran == null) continue; // no timestamp — can't prove stuck
    const age = now - ran;
    if (age > stallMs && (!oldest || age > oldest.ageMs)) {
      oldest = { name: p.name || st.name || "tool", id: p.id || st.id || null, ageMs: Math.round(age) };
    }
  }
  return oldest;
}
async function ocInterrupt(apiBase, H, sessionId) {
  try {
    const r = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST", headers: H });
    return r.ok;
  } catch { return false; }
}
async function ocPromptStop(apiBase, H, sessionId) {
  // Belt-and-braces after interrupt(): tell the agent to stop what it was doing.
  // Fire-and-forget — the session is being parked as blocked anyway.
  try {
    await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST", headers: H,
      body: JSON.stringify({ text: "STOP — your kanban task was marked blocked (stalled tool). Do not start new work. Acknowledge briefly." }),
    });
  } catch { /* best-effort */ }
}

server.registerTool(
  "kanban_message_to",
  {
    title: "Follow-up in the same subtask session",
    description:
      "Send a follow-up question into an EXISTING subtask session (same thread, no new task) and WAIT for the next assistant message — returns {sessionId, taskId, resultText}. Use after kanban_delegate when you want to ask more in the same session. Pass sessionId (from a delegate return) or taskId (resolves to its sessionId).",
    inputSchema: {
      sessionId: z.string().optional().describe("Subtask session id (from a delegate return). Either this or taskId."),
      taskId: z.string().optional().describe("Subtask id — resolves to its sessionId. Either this or sessionId."),
      text: z.string().describe("Follow-up question/instruction for the teammate"),
      timeoutSec: z.number().optional().describe("Max seconds to wait for the reply (default 120, cap 600)"),
      pollMs: z.number().optional().describe("Poll interval in ms (default 1500)"),
    },
  },
  async (args) => {
    const text = (args.text || "").trim();
    if (!text) return { content: [{ type: "text", text: "text required" }], isError: true };
    let sessionId = (args.sessionId || "").trim();
    const taskId = args.taskId || null;
    if (!sessionId && taskId) {
      const row = runCli(["task", "show", taskId]);
      if (!row.ok) return { content: [{ type: "text", text: row.text }], isError: true };
      try { sessionId = (JSON.parse(row.text).sessionId || "").trim(); } catch { /* */ }
      if (!sessionId) return { content: [{ type: "text", text: `task ${taskId} has no sessionId yet` }], isError: true };
    }
    if (!sessionId) return { content: [{ type: "text", text: "sessionId or taskId required" }], isError: true };
    const timeout = Math.min(Math.max(Number(args.timeoutSec) || 120, 15), 600);
    const interval = Math.min(Math.max(Number(args.pollMs) || 1500, 1000), 10000);
    const apiBase = ocBase();
    const H = ocH();
    try {
      let beforeId = null;
      try { beforeId = ocLastAssistant(await ocMessages(apiBase, H, sessionId, 20)).id; } catch { /* fresh */ }
      const pRes = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text }) });
      if (!pRes.ok) throw new Error(`send prompt failed (HTTP ${pRes.status}) — ${(await pRes.text().catch(() => "")).slice(0, 300)}`);
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        await sleep(interval);
        let list;
        try { list = await ocMessages(apiBase, H, sessionId, 30); } catch { continue; }
        const found = ocLastAssistant(list);
        if (found.text && found.id !== beforeId) {
          const rt = found.text.length > 4000 ? found.text.slice(0, 4000) : found.text;
          return { content: [{ type: "text", text: JSON.stringify({ sessionId, taskId, resultText: rt, resultTruncated: found.text.length > 4000, messageId: found.id, waited: true }, null, 2) }] };
        }
        if (Date.now() >= deadline) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `message_to timed out after ${timeout}s — no new assistant message in ${sessionId}`, sessionId, taskId }, null, 2) }], isError: true };
        }
      }
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message || e), sessionId, taskId }, null, 2) }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
