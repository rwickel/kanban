import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, promises as fsp } from "node:fs";
import { resolve as resolvePath, relative as relativePath, dirname as dirnamePath, sep as sepPath } from "node:path";

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

function html(res, code, str) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(str);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function opencodeAuthHeaders(password) {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

// Server-side OpenCode creds: password lives ONLY in Node (file/env).
// The browser never stores it — it calls /api/kanban/oc/* and Vite injects auth.
// Write once via PUT /api/kanban/server (Server modal) or .env.
function credsFile() {
  return join(dirname(DB), "opencode.json");
}
function loadServerCreds() {
  const file = credsFile();
  let fromFile = {};
  try {
    if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, "utf8") || "{}");
  } catch { /* corrupted — fall through to env */ }
  return {
    url: fromFile.url || process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4099",
    password: fromFile.password ?? process.env.OPENCODE_SERVER_PASSWORD ?? process.env.KANBAN_OPENCODE_PASSWORD ?? "",
  };
}

// ---- message_to helpers: follow-up in the SAME subtask session ----
// Only the last assistant text message is relevant as the return value.
function ocApiBase(serverUrl) {
  const base = ((serverUrl || loadServerCreds().url || "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}
function ocAuthHeaders(password) {
  const stored = loadServerCreds();
  const pw = password ?? stored.password ?? "";
  return { "Content-Type": "application/json", ...opencodeAuthHeaders(pw) };
}
async function ocFetchMessages(apiBase, H, sessionId, limit = 30) {
  const r = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=desc`, { headers: H });
  if (!r.ok) throw new Error(`fetch messages failed (HTTP ${r.status}) — ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j?.data ?? []);
  return Array.isArray(list) ? list : [];
}
function msgTextOf(m) {
  // Covers v2 shapes: {text}, {content:[{type:text, text}]}, {info:{text}}, {parts:[...]}
  if (!m || typeof m !== "object") return "";
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  const info = m.info;
  if (info && typeof info.text === "string" && info.text.trim()) return info.text.trim();
  const pools = [];
  if (Array.isArray(m.content)) pools.push(...m.content);
  if (Array.isArray(m.parts)) pools.push(...m.parts);
  const texts = [];
  for (const p of pools) {
    if (!p || typeof p !== "object") continue;
    const t = String(p.type || "").toLowerCase();
    if (t === "text" && typeof p.text === "string" && p.text.trim()) texts.push(p.text.trim());
  }
  return texts.join("\n").trim();
}
function msgRoleOf(m) {
  if (!m || typeof m !== "object") return "";
  for (const k of ["role", "type"]) {
    if (typeof m[k] === "string") {
      const v = m[k].toLowerCase();
      if (["assistant", "agent", "ai", "user", "system"].includes(v)) return v;
    }
  }
  if (m.info && typeof m.info.role === "string") return m.info.role.toLowerCase();
  return "";
}
function extractLastAssistant(messages) {
  // Newest first preferred; walk from end if asc. Skip user/system/reasoning/tool noise.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = msgRoleOf(m);
    if (role === "user" || role === "system") continue;
    const text = msgTextOf(m);
    if (text) return { text, id: m.id ?? m.messageID ?? null };
  }
  return { text: "", id: null };
}
function capResult(text, cap = 4000) {
  if (!text) return { resultText: "", resultTruncated: false };
  if (text.length <= cap) return { resultText: text, resultTruncated: false };
  return { resultText: text.slice(0, cap), resultTruncated: true };
}

// POST /api/kanban/message_to { sessionId?|taskId?, text*, timeoutSec?=120, pollMs?=1500 }
// → { sessionId, taskId, resultText, resultTruncated, waited:true }
// Sends a follow-up into the SAME session (no new task) and waits for the
// next assistant message. Used after delegate when the parent wants to ask more.
async function messageToSession(opts) {
  const { sessionId: sidIn, taskId, text, timeoutSec = 120, pollMs = 1500, serverUrl, serverPassword } = opts || {};
  const bodyText = (text || "").trim();
  if (!bodyText) throw { status: 400, message: "text required" };
  let sessionId = (sidIn || "").trim();
  let resolvedTaskId = taskId || null;
  if (!sessionId && taskId) {
    const row = await cli(["task", "show", taskId]);
    sessionId = (row.sessionId || row.session_id || "").trim?.() || row.sessionId || "";
    if (!sessionId) throw { status: 400, message: `task ${taskId} has no sessionId yet` };
  }
  if (!sessionId) throw { status: 400, message: "sessionId or taskId required" };
  const timeout = Math.min(Math.max(Number(timeoutSec) || 120, 15), 600);
  const interval = Math.min(Math.max(Number(pollMs) || 1500, 1000), 10000);
  const apiBase = ocApiBase(serverUrl);
  const H = ocAuthHeaders(serverPassword);

  // Baseline: newest assistant message id before we send (so we wait for a NEW one).
  let beforeId = null;
  try {
    const before = await ocFetchMessages(apiBase, H, sessionId, 20);
    beforeId = extractLastAssistant(before).id;
  } catch { /* session may be fresh — keep going */ }

  const pRes = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST", headers: H, body: JSON.stringify({ text: bodyText }),
  });
  if (!pRes.ok) {
    const t = await pRes.text().catch(() => "");
    const status = pRes.status === 404 ? 404 : 502;
    throw { status, message: `send prompt failed (HTTP ${pRes.status}) — ${t.slice(0, 300)}`, sessionId, taskId: resolvedTaskId };
  }

  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    await sleep(interval);
    let list;
    try {
      list = await ocFetchMessages(apiBase, H, sessionId, 30);
    } catch { continue; }
    const found = extractLastAssistant(list);
    if (found.text && found.id !== beforeId) {
      const capped = capResult(found.text);
      return { sessionId, taskId: resolvedTaskId, ...capped, messageId: found.id, waited: true };
    }
    if (Date.now() >= deadline) {
      const capped = found.text ? capResult(found.text) : { resultText: "", resultTruncated: false };
      throw { status: 504, message: `message_to timed out after ${timeout}s — no new assistant message in ${sessionId}`, sessionId, taskId: resolvedTaskId, ...capped };
    }
  }
}

// Synchronous agent→agent delegation: create a task for a teammate, run it
// immediately via the OpenCode server, and WAIT (poll SQLite) until it lands
// in done/blocked — like a normal read/write tool call that returns a value.
// Returns { task, sessionId } on success; throws { status, message } on failure.
async function delegateTask(opts) {
  const {
    projectId, title, description = "", priority = "medium",
    agentId, agentName, modelId, modelProviderID,
    serverUrl, serverPassword, timeoutSec = 600, pollMs = 3000, wait = true,
  } = opts || {};
  if (!projectId || !title) {
    throw { status: 400, message: "projectId and title required" };
  }
  const timeout = Math.min(Math.max(Number(timeoutSec) || 600, 30), 1800);
  const interval = Math.min(Math.max(Number(pollMs) || 3000, 1000), 15000);

  // 1. Project row → session working directory.
  const projects = await cli(["project", "list", "--json"]);
  const project = (Array.isArray(projects) ? projects : []).find((p) => p.id === projectId);
  if (!project) throw { status: 404, message: `Project not found: ${projectId}` };

  // 2. Create the subtask (backlog), then flip to running.
  const created = await cli([
    "task", "create", "--project", projectId, "--title", title, "--actor", "delegate",
    "--description", description, "--priority", priority,
    ...(agentId ? ["--agent-id", agentId] : []),
    ...(agentName ? ["--agent-name", agentName] : []),
    ...(modelId ? ["--model-id", modelId] : []),
    ...(modelProviderID ? ["--model-provider", modelProviderID] : []),
  ]);
  const tid = created.id;
  await cli(["task", "move", tid, "running", "--actor", "delegate"]);

  const base = ((serverUrl || loadServerCreds().url || "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
  const apiBase = base.endsWith("/api") ? base : `${base}/api`;
  const stored = loadServerCreds();
  const password = serverPassword ?? stored.password ?? "";
  const H = { "Content-Type": "application/json", ...opencodeAuthHeaders(password) };

  try {
    // 3. Spawn the teammate session in the project directory.
    const sessBody = {};
    if (agentId || agentName) sessBody.agent = agentId || agentName;
    if (modelId && modelProviderID) sessBody.model = { providerID: modelProviderID, id: modelId };
    if (project.path) sessBody.location = { directory: project.path };
    const sessRes = await fetch(`${apiBase}/session`, { method: "POST", headers: H, body: JSON.stringify(sessBody) });
    if (!sessRes.ok) {
      const t = await sessRes.text().catch(() => "");
      throw new Error(`session create failed (HTTP ${sessRes.status}) — ${t.slice(0, 300)}`);
    }
    const sessJson = await sessRes.json();
    const session = sessJson?.data ?? sessJson;
    if (!session?.id) throw new Error("session create returned no id");
    await cli(["task", "update", tid, "--actor", "delegate", "--session-id", session.id,
      ...(agentId ? ["--agent-id", agentId] : []),
      ...(agentName ? ["--agent-name", agentName] : []),
      "--startup-phase", "ready"]);

    // 4. Send the work prompt — subtask finishes via PATCH …/tasks/:id {status:"done"}.
    const prompt =
      `You are ${agentName || agentId || "a teammate"} executing a delegated subtask. Complete it end-to-end in ${project.path || project.name}.\n` +
      `Task id: ${tid}\nProject id: ${projectId}\nTask: ${title}\nDescription: ${description || "(none)"}\n\n` +
      `When finished, PATCH http://localhost:3001/api/kanban/tasks/${tid} with {"status":"done"} (or {"status":"blocked"} if stuck). ` +
      `That status flip is your return value — the delegating agent is blocked waiting for it.`;
    const pRes = await fetch(`${apiBase}/session/${session.id}/prompt`, {
      method: "POST", headers: H, body: JSON.stringify({ text: prompt }),
    });
    if (!pRes.ok) {
      const t = await pRes.text().catch(() => "");
      throw new Error(`send prompt failed (HTTP ${pRes.status}) — ${t.slice(0, 300)}`);
    }

    if (wait === false || wait === "false") {
      return { task: await cli(["task", "show", tid]), sessionId: session.id, waited: false };
    }

    // 5. Block until done/blocked (or timeout) — the "tool call return".
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      await sleep(interval);
      const cur = await cli(["task", "show", tid]);
      if (cur.status === "done" || cur.status === "blocked") {
        return { task: cur, sessionId: session.id, waited: true };
      }
      if (Date.now() >= deadline) {
        throw { status: 504, message: `delegate timed out after ${timeout}s — task ${tid} still ${cur.status}`, task: cur, sessionId: session.id };
      }
    }
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) throw err;
    // Spawn/prompt failure → park the subtask as blocked so the board shows it.
    let cur = null;
    try {
      cur = await cli(["task", "update", tid, "--actor", "delegate", "--status", "blocked",
        "--startup-phase", "error", "--startup-error", String(err?.message || err).slice(0, 500)]);
    } catch { /* keep original error */ }
    throw { status: 502, message: String(err?.message || err), task: cur };
  }
}

// Interactive try-it-out docs page (no auth, no deps).
// Fetches ./openapi.json at load so the UI always matches the router.
function kanbanDocsPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>kanban API — try it out</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#f1f5f9; --mut:#94a3b8; --grn:#34d399; --blu:#60a5fa; --amb:#fbbf24; --red:#f87171; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 system-ui,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); } header h1 { margin:0; font-size:18px; }
  header p { margin:4px 0 0; color:var(--mut); font-size:12px; } header code { color:var(--blu); }
  main { max-width:900px; margin:0 auto; padding:20px 16px 60px; display:flex; flex-direction:column; gap:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .m { font:700 11px/1 ui-monospace,monospace; padding:4px 8px; border-radius:4px; border:1px solid var(--line); }
  .m.GET{color:var(--grn);} .m.POST{color:var(--blu);} .m.PATCH,.m.PUT{color:var(--amb);} .m.DELETE{color:var(--red);}
  code.p { font-family:ui-monospace,monospace; font-size:13px; } .sum { color:var(--mut); font-size:12px; }
  details { margin-top:10px; } summary { cursor:pointer; color:var(--blu); font-size:13px; }
  textarea,input[type=text] { width:100%; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:8px 10px; font:12px/1.5 ui-monospace,monospace; }
  textarea { min-height:90px; resize:vertical; }
  .btn { background:var(--blu); color:#0b1220; border:0; border-radius:6px; padding:8px 16px; font-weight:700; cursor:pointer; }
  .btn:disabled { opacity:.5; } .meta { font-size:12px; } .ok{color:var(--grn);} .err{color:var(--red);}
  pre.res { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; max-height:400px; overflow:auto; font-size:12px; white-space:pre-wrap; }
  a { color:var(--blu); }
</style>
</head>
<body>
<header>
  <h1>kanban API — try it out</h1>
  <p>No auth. Local store only (<code>/api/kanban/*</code>). Spec: <a href="./openapi.json">openapi.json</a> · Markdown: <a href="https://github.com" target="_blank">docs/KANBAN_API.md</a></p>
</header>
<main id="app"><p class="sum">Loading spec…</p></main>
<script>
async function main() {
  const app = document.getElementById('app');
  let spec;
  try {
    spec = await (await fetch('./openapi.json')).json();
  } catch (e) { app.innerHTML = '<p class="err">Could not load openapi.json: ' + e + '</p>'; return; }
  app.innerHTML = '';
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const M = method.toUpperCase();
      const card = document.createElement('div');
      card.className = 'card';
      const needsBody = !!op.requestBody;
      const params = (op.parameters || []).map(p => p.name + (p.in === 'query' ? '?' : '')).join(', ');
      card.innerHTML =
        '<div class="row"><span class="m ' + M + '">' + M + '</span><code class="p">' + path + '</code>' +
        '<span class="sum">' + (op.summary || '') + '</span></div>' +
        (params ? '<div class="sum" style="margin-top:4px">params: ' + params + '</div>' : '') +
        '<details open><summary>Try it out</summary><div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">' +
        '<input type="text" data-k="url" value="' + path + '" />' +
        (needsBody ? '<textarea data-k="body">' + JSON.stringify(sampleBody(path, M), null, 2) + '</textarea>' : '') +
        '<div class="row"><button class="btn">Send</button><span class="meta sum"></span></div>' +
        '<pre class="res" hidden></pre></div></details>';
      const urlInput = card.querySelector('[data-k=url]');
      const bodyInput = card.querySelector('[data-k=body]');
      const btn = card.querySelector('.btn');
      const meta = card.querySelector('.meta');
      const pre = card.querySelector('.res');
      btn.onclick = async () => {
        btn.disabled = true; meta.textContent = 'sending…'; pre.hidden = true;
        const t0 = performance.now();
        try {
          const init = { method: M };
          if (bodyInput) { init.headers = { 'Content-Type': 'application/json' }; init.body = bodyInput.value; }
          const res = await fetch(urlInput.value.trim(), init);
          const txt = await res.text();
          meta.innerHTML = '<span class="' + (res.ok ? 'ok' : 'err') + '">' + res.status + '</span> · ' + Math.round(performance.now() - t0) + 'ms · ' + (txt.length / 1024).toFixed(1) + 'kb';
          pre.hidden = false;
          try { pre.textContent = JSON.stringify(JSON.parse(txt), null, 2).slice(0, 30000); }
          catch { pre.textContent = txt.slice(0, 30000); }
        } catch (e) { meta.innerHTML = '<span class="err">fetch failed: ' + e + '</span>'; }
        btn.disabled = false;
      };
      // Replace {id} with first task id for convenience
      if (path.includes('{id}')) {
        try {
          const tasks = await (await fetch('./tasks?limit=1')).json().catch(() => null);
        } catch {}
      }
      app.appendChild(card);
    }
  }
}
function sampleBody(path, method) {
  if (path === '/api/kanban/tasks' && method === 'POST') return { projectId: 'PASTE_PROJECT_ID', title: 'Probe task (safe to delete)', description: 'sent from /api/kanban/docs' };
  if (path.includes('/tasks/') && (method === 'PATCH')) return { status: 'done' };
  if (path === '/api/kanban/projects' && method === 'POST') return { name: 'probe-project', folder: 'probe-folder' };
  if (path.includes('/projects/')) return { description: 'updated from docs page' };
  if (path.includes('/clone')) return { url: 'https://github.com/example/repo.git', folder: 'probe-clone' };
  return {};
}
main();
</script>
</body>
</html>`;
}

// JSON catalogue (machine-readable route list). Served at ?format=json
// so /api/kanban/docs itself can be the human try-it-out page.
function kanbanDocs() {
  return {
    ok: true,
    base: "/api/kanban",
    auth: "none - local store only. Other /api/* paths proxy to OpenCode :4096 and need Basic opencode:<password>.",
    routes: [
      { method: "GET", path: "/api/kanban/tasks", query: "projectId?, status=backlog|running|done|blocked?", returns: "Task[]" },
      { method: "GET", path: "/api/kanban/tasks/:id", returns: "Task (404 when missing)" },
      { method: "POST", path: "/api/kanban/tasks", body: "projectId*, title*, description?, status?, priority?, id?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?", returns: "Task" },
      { method: "PATCH", path: "/api/kanban/tasks/:id", body: "title?, description?, status?, priority?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?", returns: "Task" },
      { method: "DELETE", path: "/api/kanban/tasks/:id", returns: "{ok:true,deleted}" },
      { method: "GET", path: "/api/kanban/projects", returns: "Project[]" },
      { method: "POST", path: "/api/kanban/projects", body: "name*, folder?|path?, gitUrl?, gitBranch?, noMkdir?, description?, id?, agentIds[]?", returns: "Project" },
      { method: "PATCH|PUT", path: "/api/kanban/projects/:id", body: "name?, folder?|path?, gitUrl?, gitBranch?, description?, agentIds[]?", returns: "Project" },
      { method: "DELETE", path: "/api/kanban/projects/:id", returns: "{ok:true,deleted,tasksDeleted}" },
      { method: "GET", path: "/api/kanban/projects/:id/git-check", returns: "{ok,current,pinned}" },
      { method: "GET", path: "/api/kanban/roots", returns: "{root,folders}" },
      { method: "GET", path: "/api/kanban/folders", returns: "{root,folders}" },
      { method: "GET", path: "/api/kanban/folders/:name/git", returns: "{folder,isRepo,branch,dirty,remote,branches}" },
      { method: "POST", path: "/api/kanban/clone", body: "url*, folder*, branch?", returns: "{ok:true,folder,path}" },
      { method: "GET", path: "/api/kanban/events", query: "task?, limit=50", returns: "Event[]" },
      { method: "GET|PUT", path: "/api/kanban/server", body: "PUT: url?, password? — stores OpenCode creds once so delegate needs no per-call password", returns: "{url, hasPassword}" },
      { method: "POST", path: "/api/kanban/delegate", body: "projectId*, title*, description?, priority?, agentId?, agentName?, modelId?, modelProviderID?, serverUrl?, serverPassword?, timeoutSec?=600, pollMs?=3000, wait?=true — creates a subtask for a teammate, runs it NOW, WAITS until done/blocked and returns the finished Task (like read/write). Long-poll; send timeoutSec generously.", returns: "{task, sessionId, waited}" },
      { method: "POST", path: "/api/kanban/message_to", body: "sessionId?|taskId?*, text*, timeoutSec?=120, pollMs?=1500 — follow-up in SAME subtask session (no new task). Waits for the next assistant message and returns {sessionId, taskId, resultText, resultTruncated}. Use after delegate.", returns: "{sessionId, taskId, resultText, resultTruncated, messageId, waited}" },
      { method: "GET", path: "/api/kanban/docs", returns: "try-it-out HTML page (?format=json → catalogue)" },
      { method: "GET", path: "/api/kanban/openapi.json", returns: "OpenAPI 3.0 spec" },
    ],
    errors: {
      400: "bad input (invalid status, projectId and title required, name required, url and folder required)",
      404: "unknown kanban route, or Task/Project not found",
      500: "anything else (e.g. failed git clone)",
      502: "OpenCode proxy failed (bad gateway — check OpenCode is running)",
    },
  };
}

function kanbanOpenApi() {
  const taskSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: ["backlog", "running", "done", "blocked"] },
      priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
      agentId: { type: ["string", "null"] },
      agentName: { type: ["string", "null"] },
      sessionId: { type: ["string", "null"] },
      modelId: { type: ["string", "null"] },
      modelProviderID: { type: ["string", "null"] },
      startupPhase: { type: ["string", "null"] },
      startupError: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: ["id", "projectId", "title", "status", "priority"],
  };
  const projectSchema = {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      path: { type: "string" },
      folder: { type: "string" },
      gitUrl: { type: ["string", "null"] },
      gitBranch: { type: "string" },
      description: { type: "string" },
      agentIds: { type: "array", items: { type: "string" } },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "name"],
  };
  const eventSchema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      ts: { type: "string", format: "date-time" },
      task_id: { type: ["string", "null"] },
      actor: { type: "string" },
      action: { type: "string" },
      details: { type: ["string", "null"] },
    },
  };
  const errSchema = {
    type: "object",
    properties: { ok: { type: "boolean" }, error: { type: "string" } },
  };
  return {
    openapi: "3.0.3",
    info: {
      title: "kanban-clone local store",
      version: "2.0.0",
      description: "No-auth CRUD over server/kanban.py (SQLite). Other /api/* paths proxy to OpenCode :4096 with Basic auth.",
    },
    paths: {
      "/api/kanban/tasks": {
        get: {
          summary: "List tasks",
          parameters: [
            { name: "projectId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string", enum: ["backlog", "running", "done", "blocked"] } },
          ],
          responses: { 200: { description: "Task[]", content: { "application/json": { schema: { type: "array", items: taskSchema } } } }, 400: { description: "invalid status", content: { "application/json": { schema: errSchema } } } },
        },
        post: {
          summary: "Create task",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "title"], properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, id: { type: "string" }, agentId: { type: "string" }, agentName: { type: "string" }, sessionId: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, startupPhase: { type: "string" }, startupError: { type: "string" } } } } } },
          responses: { 200: { description: "Task", content: { "application/json": { schema: taskSchema } } }, 400: { description: "projectId and title required", content: { "application/json": { schema: errSchema } } } },
        },
      },
      "/api/kanban/tasks/{id}": {
        get: {
          summary: "Show task",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Task", content: { "application/json": { schema: taskSchema } } }, 404: { description: "not found", content: { "application/json": { schema: errSchema } } } },
        },
        patch: {
          summary: "Update task",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, agentId: { type: "string" }, agentName: { type: "string" }, sessionId: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, startupPhase: { type: "string" }, startupError: { type: "string" } } } } } },
          responses: { 200: { description: "Task", content: { "application/json": { schema: taskSchema } } }, 404: { description: "not found", content: { "application/json": { schema: errSchema } } } },
        },
        delete: {
          summary: "Delete task",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{ok,deleted}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/projects": {
        get: {
          summary: "List projects",
          responses: { 200: { description: "Project[]", content: { "application/json": { schema: { type: "array", items: projectSchema } } } } },
        },
        post: {
          summary: "Create project",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, folder: { type: "string" }, path: { type: "string" }, gitUrl: { type: "string" }, gitBranch: { type: "string" }, noMkdir: { type: "boolean" }, description: { type: "string" }, id: { type: "string" }, agentIds: { type: "array", items: { type: "string" } } } } } } },
          responses: { 200: { description: "Project", content: { "application/json": { schema: projectSchema } } }, 400: { description: "name required", content: { "application/json": { schema: errSchema } } } },
        },
      },
      "/api/kanban/projects/{id}": {
        patch: {
          summary: "Update project",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Project", content: { "application/json": { schema: projectSchema } } } },
        },
        delete: {
          summary: "Delete project + tasks",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{ok,deleted,tasksDeleted}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/projects/{id}/git-check": {
        get: {
          summary: "Branch pin check",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{ok,current,pinned}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/roots": {
        get: {
          summary: "Folders under PROJECTS_ROOT",
          responses: { 200: { description: "{root,folders}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/folders": {
        get: {
          summary: "Folders under PROJECTS_ROOT",
          responses: { 200: { description: "{root,folders}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/folders/{name}/git": {
        get: {
          summary: "Git info for folder",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "git info", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/clone": {
        post: {
          summary: "git clone into PROJECTS_ROOT/folder",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url", "folder"], properties: { url: { type: "string" }, folder: { type: "string" }, branch: { type: "string" } } } } } },
          responses: { 200: { description: "{ok,folder,path}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/events": {
        get: {
          summary: "Audit log",
          parameters: [
            { name: "task", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "string", default: "50" } },
          ],
          responses: { 200: { description: "Event[]", content: { "application/json": { schema: { type: "array", items: eventSchema } } } } },
        },
      },
      "/api/kanban/delegate": {
        post: {
          summary: "Delegate to a teammate NOW and wait for the result (sync, like read/write)",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "title"], properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, agentId: { type: "string" }, agentName: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, serverUrl: { type: "string" }, serverPassword: { type: "string" }, timeoutSec: { type: "integer", default: 600 }, pollMs: { type: "integer", default: 3000 }, wait: { type: "boolean", default: true } } } } } },
          responses: { 200: { description: "{task, sessionId, waited}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/message_to": {
        post: {
          summary: "Follow-up in the SAME subtask session (no new task) — waits for next assistant message",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { sessionId: { type: "string" }, taskId: { type: "string" }, text: { type: "string" }, serverUrl: { type: "string" }, serverPassword: { type: "string" }, timeoutSec: { type: "integer", default: 120 }, pollMs: { type: "integer", default: 1500 } } } } } },
          responses: { 200: { description: "{sessionId, taskId, resultText, resultTruncated, messageId, waited}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/server": {
        get: {
          summary: "Stored OpenCode creds (url + hasPassword, never the secret)",
          responses: { 200: { description: "{url,hasPassword}", content: { "application/json": { schema: { type: "object" } } } } },
        },
        put: {
          summary: "Store OpenCode url+password once so delegate needs no per-call password",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, password: { type: "string" } } } } } },
          responses: { 200: { description: "{ok,url,hasPassword}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/docs": {
        get: {
          summary: "Try-it-out docs page (HTML; ?format=json → catalogue)",
          parameters: [{ name: "format", in: "query", schema: { type: "string", enum: ["json"] } }],
          responses: {
            200: {
              description: "HTML page, or catalogue JSON with ?format=json",
              content: { "text/html": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/kanban/openapi.json": {
        get: {
          summary: "This spec",
          responses: { 200: { description: "OpenAPI 3.0", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };
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
          // POST /api/kanban/delegate {projectId,title,...} → SYNC: create + run + wait for done
          if (req.method === "POST" && parts[0] === "delegate" && parts.length === 1) {
            const b = await readBody(req);
            try {
              return json(res, 200, await delegateTask(b));
            } catch (err) {
              return json(res, (err && err.status) || 500, {
                ok: false,
                error: (err && err.message) || String(err),
                ...(err && err.task ? { task: err.task } : {}),
                ...(err && err.sessionId ? { sessionId: err.sessionId } : {}),
              });
            }
          }
          // POST /api/kanban/message_to {sessionId?|taskId?, text} → SYNC follow-up in SAME session
          if (req.method === "POST" && parts[0] === "message_to" && parts.length === 1) {
            const b = await readBody(req);
            try {
              return json(res, 200, await messageToSession(b));
            } catch (err) {
              return json(res, (err && err.status) || 500, {
                ok: false,
                error: (err && err.message) || String(err),
                ...(err && err.sessionId ? { sessionId: err.sessionId } : {}),
                ...(err && err.taskId ? { taskId: err.taskId } : {}),
                ...(err && "resultText" in (err || {}) ? { resultText: err.resultText, resultTruncated: !!err.resultTruncated } : {}),
              });
            }
          }
          // ---- /api/kanban/oc/* → OpenCode proxy with SERVER-SIDE auth ----
          // The browser never holds the password. It calls these routes and
          // Vite injects Basic opencode:<password> from opencode.json/env.
          if (parts[0] === "oc") {
            const ocPath = "/" + parts.slice(1).join("/");
            const qs = q.toString();
            const target = `${ocApiBase()}${ocPath}${qs ? `?${qs}` : ""}`;
            const H = ocAuthHeaders();
            try {
              const hasBody = req.method === "POST" || req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE";
              const b = hasBody ? await readBody(req) : undefined;
              // SSE stream: GET /oc/event → pipe through, keep alive.
              if (req.method === "GET" && parts[1] === "event") {
                const up = await fetch(target, { headers: { Accept: "text/event-stream", ...opencodeAuthHeaders(loadServerCreds().password) } });
                if (!up.ok || !up.body) return json(res, up.status || 502, { ok: false, error: `OpenCode event stream failed (HTTP ${up.status})` });
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                const reader = up.body.getReader();
                const decoder = new TextDecoder();
                req.on("close", () => { try { reader.cancel(); } catch {} });
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(decoder.decode(value, { stream: true }));
                }
                return res.end();
              }
              const init = { method: req.method, headers: H };
              if (b !== undefined && Object.keys(b || {}).length > 0) init.body = JSON.stringify(b);
              else if (hasBody) init.body = JSON.stringify(b || {});
              const up = await fetch(target, init);
              const text = await up.text().catch(() => "");
              res.statusCode = up.status;
              const ct = up.headers.get("content-type");
              res.setHeader("Content-Type", ct || "application/json");
              return res.end(text);
            } catch (err) {
              return json(res, 502, { ok: false, error: `OpenCode proxy failed: ${String(err?.message || err).slice(0, 300)}` });
            }
          }
          // GET/PUT /api/kanban/server → store/load OpenCode url+password for delegate
          if (parts[0] === "server" && parts.length === 1) {
            if (req.method === "GET") return json(res, 200, { url: loadServerCreds().url, hasPassword: !!loadServerCreds().password });
            if (req.method === "PUT") {
              const b = await readBody(req);
              const cur = loadServerCreds();
              const next = {
                url: (b.url ?? cur.url ?? "http://127.0.0.1:4099").toString().trim() || cur.url,
                password: b.password !== undefined ? String(b.password) : cur.password,
              };
              const { writeFileSync } = await import("node:fs");
              const file = credsFile();
              const dir = dirname(file);
              const { mkdirSync } = await import("node:fs");
              try { mkdirSync(dir, { recursive: true }); } catch {}
              writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
              return json(res, 200, { ok: true, url: next.url, hasPassword: !!next.password });
            }
          }
          // POST /api/kanban/server/test {url?, password?} → test OpenCode creds
          // SERVER-SIDE so the password never stays in the browser.
          if (parts[0] === "server" && parts.length === 2 && parts[1] === "test" && req.method === "POST") {
            const b = await readBody(req);
            const stored = loadServerCreds();
            const tryUrl = ((b.url ?? stored.url ?? "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
            const tryApi = tryUrl.endsWith("/api") ? tryUrl : `${tryUrl}/api`;
            const tryPw = b.password !== undefined ? String(b.password) : stored.password;
            try {
              const up = await fetch(`${tryApi}/agent`, { headers: opencodeAuthHeaders(tryPw) });
              if (!up.ok) return json(res, up.status >= 500 ? 502 : up.status, { ok: false, status: up.status });
              const j = await up.json().catch(() => ({}));
              const list = Array.isArray(j) ? j : (j?.data ?? []);
              return json(res, 200, { ok: true, agentCount: Array.isArray(list) ? list.length : 0 });
            } catch (err) {
              return json(res, 502, { ok: false, error: `OpenCode test failed: ${String(err?.message || err).slice(0, 200)}` });
            }
          }
          // GET /api/kanban/events?task=&limit= → Event[]
          if (req.method === "GET" && parts[0] === "events" && parts.length === 1) {
            const argv = ["events", "list", "--limit", q.get("limit") || "50"];
            if (q.get("task")) argv.push("--task", q.get("task"));
            return json(res, 200, await cli(argv));
          }
          // GET /api/kanban/file?path=<abs|root-relative> → { path, rel, content, size, truncated }
          // Reads a file from inside KANBAN_PROJECTS_ROOT (confined — no escapes).
          if (req.method === "GET" && parts[0] === "file" && parts.length === 1) {
            const raw = (q.get("path") || "").trim();
            if (!raw) return json(res, 400, { ok: false, error: "path required" });
            const root = (process.env.KANBAN_PROJECTS_ROOT || "").trim();
            if (!root) return json(res, 500, { ok: false, error: "KANBAN_PROJECTS_ROOT not set" });
            const abs = resolvePath(root, raw);
            const rel = relativePath(resolvePath(root), abs);
            if (rel.startsWith("..") || resolvePath(root, rel) !== abs) {
              return json(res, 403, { ok: false, error: "path escapes projects root" });
            }
            try {
              const stat = await fsp.stat(abs);
              if (stat.isDirectory()) return json(res, 400, { ok: false, error: "path is a directory" });
              if (stat.size > 512 * 1024) return json(res, 413, { ok: false, error: "file too large (>512kb)" });
              const content = await fsp.readFile(abs, "utf8");
              const cap = 20000;
              return json(res, 200, {
                ok: true, path: abs,
                rel: rel.split(sepPath).join("/"),
                size: stat.size,
                truncated: content.length > cap,
                content: content.length > cap ? content.slice(0, cap) : content,
              });
            } catch (err) {
              return json(res, 404, { ok: false, error: `cannot read file: ${String(err?.message || err).slice(0, 300)}` });
            }
          }
          // GET /api/kanban/file/diff?path=<abs|root-relative> → { path, rel, diff, dirty }
          // git diff (worktree vs HEAD) scoped to the file, run in its repo root.
          if (req.method === "GET" && parts[0] === "file" && parts.length === 2 && parts[1] === "diff") {
            const raw = (q.get("path") || "").trim();
            if (!raw) return json(res, 400, { ok: false, error: "path required" });
            const root = (process.env.KANBAN_PROJECTS_ROOT || "").trim();
            if (!root) return json(res, 500, { ok: false, error: "KANBAN_PROJECTS_ROOT not set" });
            const abs = resolvePath(root, raw);
            const rel = relativePath(resolvePath(root), abs);
            if (rel.startsWith("..") || resolvePath(root, rel) !== abs) {
              return json(res, 403, { ok: false, error: "path escapes projects root" });
            }
            const { execFile: ef } = await import("node:child_process");
            const { promisify: prom } = await import("node:util");
            const efAsync = prom(ef);
            // Walk up from the file to find the enclosing .git.
            let dir = dirnamePath(abs);
            const stop = resolvePath(root);
            let repoRoot = null;
            for (;;) {
              try {
                const st = await fsp.stat(join(dir, ".git"));
                if (st) { repoRoot = dir; break; }
              } catch { /* keep walking */ }
              if (dir === stop || dir === dirnamePath(dir)) break;
              dir = dirnamePath(dir);
            }
            if (!repoRoot) return json(res, 200, { ok: true, path: abs, rel: rel.split(sepPath).join("/"), diff: "", dirty: false, note: "not a git repo" });
            try {
              const { stdout } = await efAsync("git", ["diff", "HEAD", "--", abs], { cwd: repoRoot, encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
              const diff = (stdout || "").slice(0, 20000);
              return json(res, 200, { ok: true, path: abs, rel: rel.split(sepPath).join("/"), diff, dirty: diff.trim().length > 0 });
            } catch (err) {
              return json(res, 500, { ok: false, error: String(err?.message || err).slice(0, 300) });
            }
          }
          // GET /api/kanban/docs → interactive try-it-out page (HTML, no auth).
          // Append ?format=json for the machine-readable route catalogue.
          if (req.method === "GET" && parts[0] === "docs" && parts.length === 1) {
            if (q.get("format") === "json") return json(res, 200, kanbanDocs());
            return html(res, 200, kanbanDocsPage());
          }
          // GET /api/kanban/openapi.json → OpenAPI 3.0 spec for the local store
          if (req.method === "GET" && parts[0] === "openapi.json" && parts.length === 1) {
            return json(res, 200, kanbanOpenApi());
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
