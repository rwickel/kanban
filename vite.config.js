import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync, promises as fsp } from "node:fs";
import { resolve as resolvePath, relative as relativePath, dirname as dirnamePath, sep as sepPath } from "node:path";
import { loadEnvFile } from "./scripts/env.mjs";
import { randomUUID } from "node:crypto";
import {
  LINKBACK_CAP_PER_PARENT,
  linkbackEnabled,
  groupPending,
  planDeliveries,
} from "./scripts/linkback.mjs";
import { completionStatus } from "./scripts/task-completion.mjs";

const execFileAsync = promisify(execFile);

const VALID_STATUSES = new Set(["backlog", "running", "done", "blocked"]);

loadEnvFile();

// Option B: SQLite store owned by server/kanban.py (uuid model).
// Shared file so host, Vite, plugin, and Docker see the same truth:
//   host:      <repo>/.kanban-data/kanban.db
//   container: /work/kanban-clone/.kanban-data/kanban.db
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "server", "kanban.py");
const DB =
  process.env.KANBAN_DB ||
  join(process.env.KANBAN_DATA_DIR || join(HERE, ".kanban-data"), "kanban.db");
const PYTHON = process.env.KANBAN_PYTHON || "python";
const ATTACHMENT_DIR = join(process.env.KANBAN_DATA_DIR || join(HERE, ".kanban-data"), "attachments");
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "application/json", "application/zip"]);

function readRawBody(req, limit = MAX_ATTACHMENT_SIZE + 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error("Request is too large."), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function attachmentRoute(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attachments") return false;
  const metadataPath = (id) => join(ATTACHMENT_DIR, `${id}.json`);
  if (req.method === "POST" && parts.length === 1) {
    const ownerType = url.searchParams.get("ownerType");
    const ownerId = url.searchParams.get("ownerId")?.trim();
    if (!(ownerType === "task" || ownerType === "chat") || !ownerId || ownerId.length > 200) { json(res, 400, { error: "A valid attachment owner is required." }); return true; }
    try {
      const raw = await readRawBody(req);
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers["content-type"] || "");
      if (!boundary) { json(res, 400, { error: "Multipart file data is required." }); return true; }
      const marker = Buffer.from(`--${boundary[1] || boundary[2]}\r\n`);
      const start = raw.indexOf(marker);
      const headerEnd = raw.indexOf(Buffer.from("\r\n\r\n"), start + marker.length);
      const end = raw.indexOf(Buffer.from(`\r\n--${boundary[1] || boundary[2]}`), headerEnd + 4);
      if (start < 0 || headerEnd < 0 || end < 0) { json(res, 400, { error: "Invalid upload data." }); return true; }
      const headers = raw.subarray(start + marker.length, headerEnd).toString("utf8");
      const name = /filename="([^"]*)"/i.exec(headers)?.[1]?.replace(/[\\/]/g, "_").trim();
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() || "application/octet-stream";
      const data = raw.subarray(headerEnd + 4, end);
      if (!name) { json(res, 400, { error: "File name is required." }); return true; }
      if (data.length > MAX_ATTACHMENT_SIZE) { json(res, 413, { error: "Files must be 10 MB or smaller." }); return true; }
      if (!ALLOWED_ATTACHMENT_TYPES.has(type)) { json(res, 415, { error: "This file type is not supported." }); return true; }
      await fsp.mkdir(ATTACHMENT_DIR, { recursive: true });
      const id = randomUUID();
      const ext = /\.([a-z\d]{1,10})$/i.exec(name)?.[1]?.toLowerCase() || "";
      const storedName = `${id}${ext ? `.${ext}` : ""}`;
      await fsp.writeFile(join(ATTACHMENT_DIR, storedName), data, { flag: "wx" });
      const attachment = { id, name, type, size: data.length, ownerType, ownerId, storedName };
      await fsp.writeFile(metadataPath(id), JSON.stringify(attachment), { flag: "wx" });
      attachment.url = `/api/kanban/attachments/${id}/content`;
      json(res, 201, attachment);
    } catch (error) { json(res, error.status || 500, { error: error.message || "Upload failed." }); }
    return true;
  }
  if (req.method === "GET" && parts.length === 1) {
    const ownerType = url.searchParams.get("ownerType"); const ownerId = url.searchParams.get("ownerId");
    try {
      const files = await fsp.readdir(ATTACHMENT_DIR).catch(() => []);
      const items = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await fsp.readFile(join(ATTACHMENT_DIR, file), "utf8"))));
      json(res, 200, items.filter((item) => item.ownerType === ownerType && item.ownerId === ownerId).map((item) => ({ ...item, uri: pathToFileURL(resolvePath(ATTACHMENT_DIR, item.storedName || item.id)).href })));
    } catch { json(res, 500, { error: "Could not list attachments." }); }
    return true;
  }
  if ((req.method === "GET" || req.method === "DELETE") && (parts.length === 2 || parts.length === 3)) {
    const id = parts[1];
    if (!/^[\da-f-]{36}$/i.test(id)) { json(res, 404, { error: "Attachment not found." }); return true; }
    try {
      const item = JSON.parse(await fsp.readFile(metadataPath(id), "utf8"));
      if (req.method === "DELETE" && parts.length === 2) {
        await fsp.unlink(join(ATTACHMENT_DIR, item.storedName || item.id)); await fsp.unlink(metadataPath(id)); json(res, 200, { ok: true });
      } else {
        const data = await fsp.readFile(join(ATTACHMENT_DIR, item.storedName || item.id));
        res.statusCode = 200; res.setHeader("Content-Type", item.type); res.setHeader("Content-Length", data.length);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", `${parts[2] === "content" && item.type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`); res.end(data);
      }
    } catch { json(res, 404, { error: "Attachment not found." }); }
    return true;
  }
  json(res, 404, { error: "Attachment route not found." }); return true;
}

async function cli(args) {
  const { stdout } = await execFileAsync(PYTHON, [CLI, "--db", DB, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse((stdout || "null").trim() || "null");
}

// Map a CLI error text to an HTTP status code.
// The browser needs the status code and the text. A bare 500 hides the cause.
function cliErrorStatus(msg) {
  const m = String(msg || "");
  // Dependency validation errors are user input problems → 400.
  if (/^(Invalid blocked-by|Self-dependency rejected|Dependency cycle rejected|Too many blocked-by)/.test(m.trim()))
    return 400;
  // Only map missing DB rows to 404. Git stderr often contains
  // "Repository not found", which is a 500 (clone failed), not a
  // missing route. Mapping it to 404 masks the real git error.
  if (/(project|task|feature) not found/i.test(m)) return 404;
  // Git and worktree problems are a conflict with the current repo state.
  if (/git worktree add failed|worktree folder exists|not a git repository|project path does not exist|feature worktree is busy/i.test(m))
    return 409;
  return 500;
}

async function validateTaskModel(projectId, provider, model) {
  if (!provider && !model) return;
  if (!provider || !model) throw Object.assign(new Error("modelId and modelProviderID must be provided together"), { status: 400 });
  const projects = await cli(["project", "list", "--json"]);
  const project = (projects || []).find((p) => p.id === projectId);
  if (!project) throw Object.assign(new Error("project not found"), { status: 404 });
  const base = (process.env.OPENCODE_SERVER_URL || "http://localhost:4096").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/model`, {
    headers: process.env.OPENCODE_SERVER_PASSWORD
      ? { Authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` }
      : {},
  });
  if (!response.ok) throw Object.assign(new Error(`model endpoint returned HTTP ${response.status}`), { status: 502 });
  const payload = await response.json();
  const models = Array.isArray(payload) ? payload : (payload?.data || []);
  const key = `${provider}/${model}`;
  if (!models.some((entry) => `${entry.providerID}/${entry.modelID}` === key))
    throw Object.assign(new Error(`model is not available: ${key}`), { status: 400 });
  const allowed = Array.isArray(project.allowedModels) ? project.allowedModels : [];
  if (allowed.length && !allowed.includes(key))
    throw Object.assign(new Error(`model is not allowed by project: ${key}`), { status: 400 });
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

// ---- Server-side session reconciler: board follows session outcome, no client needed ----
// Delegated sessions have no open chat window, so SessionChatWindow's auto-move
// never fires. This poller runs in the dev server: for every task in `running`
// with a sessionId + startupPhase=ready, fetch the session's last message.
// idle/completed/succeeded/done/success → done (capture last assistant text as result).
// idle/failed/error → blocked. interrupted/aborted stays running. Runs every 15s,
// skips tasks touched in the last 20s to avoid racing an agent's own writes.
let reconcileTimer = null;
let reconcileBusy = false;
// A delegated session that remains running without producing a message is
// presumed stuck. Keep this configurable for slower providers, but fail safe
// after ten minutes by default so abandoned sessions do not run forever.
const STALE_SESSION_MS = Math.max(
  60_000,
  Number(process.env.KANBAN_STALE_SESSION_SEC || 600) * 1000,
);
// Extracts the LITERAL error text that the OpenCode session API actually
// reports. Verified shapes (live probes, Oct 2026):
//   GET /session/{id} → { id, projectID, agent, model, cost, tokens, outcome, time, title, location }
//     — the session object carries NO error field in this server version;
//     outcome is "failed" | "succeeded" | "interrupted" only. The
//     error/providerError/provider_error checks below stay as forward
//     compatibility for servers that add them.
//   GET /session/{id}/message → the last row of a failed session is a bare
//     {"type":"idle","outcome":"failed"} marker. The REAL error sits on the
//     assistant row just before it: {"type":"assistant","finish":"error",
//     "error":{"type":"provider.transport"|"provider.quota",
//     "message":"<literal text>","response":{...optional...}}}.
// Only fields that are actually present (belegte Felder) are returned —
// nothing is invented. Callers must therefore scan the whole message list
// (newest first), not just the last row (see reconcileRunning).
function sessionErrorText(value) {
  if (!value || typeof value !== "object") return "";
  const obj = value;
  for (const key of ["error", "providerError", "provider_error", "cause", "reason"]) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const message = candidate.message || candidate.detail || candidate.description;
      if (typeof message === "string" && message.trim()) {
        // error.type is a reported field too (e.g. "provider.transport") —
        // prefix it so the kind of failure is visible in resultContext.
        const type = typeof candidate.type === "string" ? candidate.type.trim() : "";
        return type && type !== "error" ? `${type}: ${message.trim()}` : message.trim();
      }
      const nested = sessionErrorText(candidate);
      if (nested) return nested;
    }
  }
  for (const key of ["data", "status", "info", "result"]) {
    const nested = sessionErrorText(obj[key]);
    if (nested) return nested;
  }
  return "";
}
function startReconciler() {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    reconcileRunning().catch(() => {});
    deliverResultsToParents().catch(() => {});
    scheduleCyclicTasks().catch(() => {});
  }, 15000);
  // First pass shortly after boot.
  setTimeout(() => reconcileRunning().catch(() => {}), 8000);
  setTimeout(() => deliverResultsToParents().catch(() => {}), 20000);
  setTimeout(() => scheduleCyclicTasks().catch(() => {}), 8000);
}
function messageTimestamp(message) {
  if (!message || typeof message !== "object") return 0;
  const candidates = [
    message.time, message.timestamp, message.createdAt, message.created_at,
    message.info?.time, message.info?.timestamp, message.info?.createdAt,
    message.time?.created, message.time?.updated, message.info?.time?.created,
    message.info?.time?.updated,
  ];
  for (const value of candidates) {
    const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  return 0;
}
async function interruptSession(apiBase, headers, sessionId) {
  await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST", headers,
  });
}
async function scheduleCyclicTasks() {
  const rows = await cli(["task", "list", "--status", "backlog"]).catch(() => []);
  const now = Date.now();
  for (const t of Array.isArray(rows) ? rows : []) {
    if (t.kind !== "cyclic" || !Number.isFinite(Number(t.cycleIntervalSec)) || Number(t.cycleIntervalSec) <= 0) continue;
    const last = Date.parse(t.updatedAt || t.updated_at || t.createdAt || t.created_at || "") || now;
    if (now - last >= Number(t.cycleIntervalSec) * 1000) {
      await cli(["task", "move", t.id, "running", "--actor", "cyclic-scheduler"]).catch(() => null);
    }
  }
}
async function reconcileRunning() {
  if (reconcileBusy) return;
  reconcileBusy = true;
  try {
    const [running, blocked, all] = await Promise.all([
      cli(["task", "list", "--status", "running"]).catch(() => []),
      cli(["task", "list", "--status", "blocked"]).catch(() => []),
      cli(["task", "list"]).catch(() => []),
    ]);
    // A reconciler error can mark a task blocked while its OpenCode session is
    // still active. Include blocked tasks so the session remains authoritative.
    const rows = [
      ...(Array.isArray(running) ? running : []),
      ...(Array.isArray(blocked) ? blocked : []),
    ];
    // Child tasks: a task that delegated work has children with its own
    // session id as parent. A parent whose turn ended without the completion
    // marker keeps waiting for them.
    const childrenByParent = new Map();
    for (const row of Array.isArray(all) ? all : []) {
      const parent = String(row.parentSessionId || row.parent_session_id || "").trim();
      if (!parent) continue;
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(row);
    }
    const apiBase = ocApiBase();
    const H = ocAuthHeaders();
    for (const t of rows) {
      try {
        const sid = t.sessionId || t.session_id;
        if (!sid) continue;
        if ((t.startupPhase || t.startup_phase) !== "ready") continue;
        const updatedAt = Date.parse(t.updatedAt || t.updated_at || "") || 0;
        if (Date.now() - updatedAt < 20000) continue;
        const msgs = await ocFetchMessages(apiBase, H, sid, 30).catch(() => null);
        const messages = Array.isArray(msgs) ? msgs : [];
        const last = messages[messages.length - 1] || null;
        const ltype = String(last?.type || "").toLowerCase();
        // Session-level outcome (getSession shape) or last-message outcome.
        let outcome = "";
        let session = null;
        try {
          const sRes = await fetch(`${apiBase}/session/${encodeURIComponent(sid)}`, { headers: H });
          if (sRes.ok) {
            const sJson = await sRes.json();
            session = sJson?.data ?? sJson;
            if (typeof session?.outcome === "string") outcome = session.outcome.toLowerCase();
          }
        } catch { /* fall back to message outcome */ }
        if (!outcome && typeof last?.outcome === "string") outcome = last.outcome.toLowerCase();
        const succeeded = ltype === "idle" && ["completed", "done", "succeeded", "success"].includes(outcome);
        const failLike = ltype === "idle" && ["failed", "error"].includes(outcome);
        const sessionFailed = ["failed", "error"].includes(outcome);
        const lastActivity = messageTimestamp(last) || messageTimestamp(session) || updatedAt;
        // An idle session is WAITING for the next message. That is normal for a
        // delegating agent: it ends its turn and the board delivers the result
        // of the sub-task later. Only a session that is mid-turn and silent is
        // stuck. A task with running sub-tasks waits for them, so it is never
        // stale either.
        const sessionIdle = ltype === "idle";
        const children = childrenByParent.get(String(sid)) || [];
        const childRunning = children.some((c) => c.status === "running");
        const stale = t.status === "running" && !succeeded && !failLike && !sessionFailed && !sessionIdle &&
          !childRunning && lastActivity > 0 && Date.now() - lastActivity >= STALE_SESSION_MS;
        if (stale) {
          await interruptSession(apiBase, H, sid).catch(() => null);
          await cli([
            "task", "update", t.id, "--actor", "reconciler", "--status", "blocked",
            "--result-context",
            `session produced no message for ${Math.round((Date.now() - lastActivity) / 1000)}s; session interrupted as stale`,
          ]).catch(() => null);
          continue;
        }
        if (!succeeded && !failLike && !sessionFailed) {
          // The session works and is not stuck. A blocked task with a live
          // session goes back to running. Never re-arm an idle session: it is
          // waiting, and re-arming would start the task a second time.
          if (t.status === "blocked" && !sessionIdle) {
            await cli(["task", "update", t.id, "--actor", "reconciler", "--status", "running"])
              .catch(() => null);
          }
          continue;
        }
        let completionSignal = "";
        // Always read the last assistant text, also for a failed session: the
        // completion marker is the agent's own statement that the work is done.
        {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (msgRoleOf(messages[i]) === "assistant") {
              completionSignal = msgTextOf(messages[i]);
              break;
            }
          }
        }
        const completion = completionStatus({ succeeded, failed: failLike || sessionFailed, kind: t.kind, finalAssistantText: completionSignal });
        let next = completion?.status || "blocked";
        // A delegating agent ends its turn before the delegated work is done.
        // Its sub-tasks carry the work. The task stays running and waits for
        // the board to deliver their results into its session.
        if (next === "blocked" && succeeded && !completionSignal.includes("KANBAN_TASK_INCOMPLETE")) {
          const waiting = children.filter((c) => c.status === "running" || c.status === "backlog");
          if (waiting.length > 0) {
            next = "running";
          }
        }
        // Last assistant text (skip user/system) → result, unless already set.
        let resultText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          const role = msgRoleOf(m);
          if (role === "user" || role === "system") continue;
          const text = msgTextOf(m);
          if (text) { resultText = text.slice(0, 4000); break; }
        }
        const argv = ["task", "update", t.id, "--actor", "reconciler", "--status", next];
        if (resultText && !(t.result || t.result_text)) argv.push("--result", resultText);
        // A task that already has this status and this result needs no new
        // write. Without this guard the event log fills with the same update.
        if (t.status === next && (t.result || t.result_text) && resultText && (t.result || t.result_text) === resultText) {
          continue;
        }
        if (next === "blocked") {
          // No fabricated network diagnosis: only the literal error the
          // session API reported. Scan the message list newest→oldest — the
          // last row is a bare idle marker, the real error sits on the
          // assistant row before it (see sessionErrorText docs).
          let errorText = sessionErrorText(session);
          if (!errorText) {
            for (let i = messages.length - 1; i >= 0; i--) {
              errorText = sessionErrorText(messages[i]);
              if (errorText) break;
            }
          }
          const context = succeeded
            ? completion?.reason || "completion was not verified"
              : errorText
                ? `session outcome: ${outcome}; error: ${errorText}`
                : `session outcome: ${outcome}; no error detail reported by the session`;
          argv.push("--result-context", context.slice(0, 4000));
        }
        await cli(argv).catch(() => null);
      } catch { /* per-task errors never stop the loop */ }
    }
  } finally {
    reconcileBusy = false;
  }
}

// ---- Result link-back: push finished task results into the parent session ----
// The reconciler above flips running → done/blocked. This second half of the
// tick delivers the outcome to the parent that delegated the work, grouped by
// parent, queued via the session inbox so a busy chat is NOT interrupted
// mid-answer (verified live: POST /prompt { delivery:"queue" } → 200, item
// shows as type:"user" in the message feed, cancel is a 204 no-op when gone).
//
// The data is the ledger: notify-pending finds done/blocked + parent + NULL
// notified_at; notify-mark (batched ids, single subprocess) stamps delivered
// ONLY after the queue POST 2xx'd, so a failed POST retries next pass and a
// restart loses nothing. wait:true callers stamp at return time (see
// delegateTask) so they never get the same result twice.
//
// Guards: self-parent (task's parent is its own session) and STATUS-only
// (backlog/running don't deliver). Toggle: KANBAN_RESULT_LINKBACK=0 disables.
//
// Every finished run costs its parent one model pass — that's the documented
// price of "results link back to this chat".
let deliverBusy = false;

async function deliverResultsToParents() {
  // Pure rules live in scripts/linkback.mjs (unit tested) — here is only I/O.
  if (!linkbackEnabled(process.env.KANBAN_RESULT_LINKBACK) || deliverBusy) return;
  deliverBusy = true;
  try {
    const pending = await cli(["task", "notify-pending", "--limit", "50"]).catch(() => []);
    const rows = Array.isArray(pending) ? pending : [];
    if (rows.length === 0) return;
    const { byParent, selfIds } = groupPending(rows);
    if (selfIds.length) {
      // Self-parented and parentless rows can never be delivered — stamp them
      // every pass so the scan stays clean even when mixed with live rows.
      await cli(["task", "notify-mark", ...selfIds, "--actor", "notifier"]).catch(() => null);
    }
    const plan = planDeliveries(byParent, LINKBACK_CAP_PER_PARENT);
    const apiBase = ocApiBase();
    const H = ocAuthHeaders();
    for (const { parent, text, ids } of plan.values()) {
      if (ids.length === 0) continue;
      try {
        const pRes = await fetch(`${apiBase}/session/${encodeURIComponent(parent)}/prompt`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({ text, delivery: "queue" }),
        });
        if (!pRes.ok) {
          // 404 = parent session pruned: stamp so we stop retrying a dead id.
          // Anything else (502, socket reset): leave NULL, retry next pass.
          if (pRes.status === 404) {
            await cli(["task", "notify-mark", ...ids, "--actor", "notifier"]).catch(() => null);
          }
          continue;
        }
        await cli(["task", "notify-mark", ...ids, "--actor", "notifier"]).catch(() => null);
      } catch { /* network down — stays NULL, retries next pass */ }
    }
  } finally {
    deliverBusy = false;
  }
}

// Infra self-healing: auto-create a backlog fix task when a startup/OC
// failure happens. Exported for use by the kanban middleware (proxy 502,
// session fetch failures, etc.) and by vite HMR (no double import needed).
const FIX_TITLE_RE = /^Fix \(infra\)/;
async function ensureInfraFixTask(projectId, title, description) {
  if (FIX_TITLE_RE.test(title)) return;
  try {
    const tasks = await cli(["task", "list", "--project", projectId]).catch(() => []);
    const dup = Array.isArray(tasks) && tasks.some((t) =>
      (t.status === "backlog" || t.status === "running") && t.title === title
    );
    if (dup) return;
    await cli(["task", "create", "--project", projectId, "--title", title,
      "--description", description, "--priority", "high", "--actor", "infra-heal"]);
  } catch { /* best-effort only */ }
}

function opencodeAuthHeaders(password) {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

// Server-side OpenCode credentials come only from the ignored root .env.
function loadServerCreds() {
  return {
    url: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4099",
    password: process.env.OPENCODE_SERVER_PASSWORD || "",
  };
}

// Customizable agent style: prompts/final-message-style.md is injected into
// every agent prompt. Edit the file, restart the dev server + plugin (opencode restart).
function loadStyleGuide() {
  try {
    const p = join(HERE, "prompts", "final-message-style.md");
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8").trim();
  } catch { return ""; }
}

// ---- message_to helpers: follow-up in the SAME subtask session ----
// Only the last assistant text message is relevant as the return value.
function ocApiBase() {
  const base = ((loadServerCreds().url || "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}
function ocAuthHeaders(password) {
  const stored = loadServerCreds();
  const pw = password ?? stored.password ?? "";
  return { "Content-Type": "application/json", ...opencodeAuthHeaders(pw) };
}
async function ocFetchMessages(apiBase, H, sessionId, limit = 30) {
  const r = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=asc`, { headers: H });
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
  const { sessionId: sidIn, taskId, text, timeoutSec = 120, pollMs = 1500 } = opts || {};
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
  const apiBase = ocApiBase();
  const H = ocAuthHeaders();

  // Baseline: newest assistant message id before we send (so we wait for a NEW one).
  // ocFetchMessages returns asc order; extractLastAssistant walks from the end.
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

// Flattens an error and its cause chain into one literal string so the
// caller of /api/kanban/delegate receives the ROOT cause — e.g. the
// "connect ECONNREFUSED 127.0.0.1:4099" that Node hides behind its generic
// "fetch failed" message — instead of a meaningless bare 502.
// Only fields the runtime actually reported are concatenated; nothing is invented.
function describeErrorCause(err) {
  const parts = [];
  let cur = err;
  let depth = 0;
  while (cur != null && depth < 4) {
    let part = "";
    if (typeof cur === "string") part = cur;
    else if (typeof cur.message === "string" && cur.message.trim()) part = cur.message;
    else if (typeof cur.code === "string" && cur.code.trim()) part = cur.code;
    else part = String(cur);
    part = part.trim();
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    cur = cur && typeof cur === "object" && cur.cause && cur.cause !== cur ? cur.cause : null;
    depth += 1;
  }
  return parts.length ? parts.join(" — cause: ") : "unknown error";
}

// Give a task its own git worktree so parallel tasks never share files,
// git index or build output. Returns { path, branch, base } or null when the
// project is not a git repo — the caller then uses the plain project folder.
async function createTaskWorktree(taskId) {
  try {
    const info = await cli(["worktree", "create", taskId]);
    if (info && info.ok && info.path) return { path: info.path, branch: info.branch, base: info.base };
  } catch {
    /* no git repo, git missing, or worktree refused — fall back to the project folder */
  }
  return null;
}

/** Prompt lines that tell the agent about its worktree and the commit rule. */
function worktreePromptLines(worktree) {
  if (!worktree?.path) return "";
  if (worktree.feature) {
    return (
      `You work in a FEATURE worktree that is shared with the other steps of this feature: ${worktree.path}\n` +
      `Feature branch: ${worktree.branch}\n` +
      `Rules: change only files inside this worktree. Commit your work on the feature branch ` +
      `(git add -A && git commit -m "..."). Do NOT merge, do NOT push, do NOT switch branches, ` +
      `and do NOT reset, clean or delete the folder — the work of the earlier steps is in it. ` +
      `Only one step works here at a time. The integrator merges the feature branch into main at the end.\n`
    );
  }
  return (
    `You work in an ISOLATED git worktree: ${worktree.path}\n` +
    `Branch: ${worktree.branch} (base ${worktree.base || "the project branch"})\n` +
    `Rules: change only files inside this worktree. Commit your work on this branch ` +
    `(git add -A && git commit -m "..."). Do NOT merge, do NOT push, do NOT switch branches, ` +
    `and do NOT edit the main project folder. The board merges your branch when the task is done. ` +
    `State the branch name and the changed files in your final message.\n`
  );
}

// Synchronous agent→agent delegation: create a task for a teammate, run it
// immediately via the OpenCode server, and WAIT (poll SQLite) until it lands
// in done/blocked — like a normal read/write tool call that returns a value.
// Returns { task, sessionId } on success; throws { status, message } on failure.
async function delegateTask(opts) {
  const {
    projectId, title, description = "", priority = "medium",
    agentId, agentName, modelId, modelProviderID,
    parentSessionId, result, resultContext, featureId,
    timeoutSec = 600, pollMs = 3000, wait = false,
  } = opts || {};
  if (!projectId || !title) {
    throw { status: 400, message: "projectId and title required" };
  }
  if (!agentId) throw { status: 400, message: "agentId required — pass a teammate agent id from the project's team (see project.agentIds)" };
  const timeout = Math.min(Math.max(Number(timeoutSec) || 600, 30), 1800);
  const interval = Math.min(Math.max(Number(pollMs) || 3000, 1000), 15000);

  // 1. Project row → session working directory + validate agent is on the team.
  const projects = await cli(["project", "list", "--json"]);
  const project = (Array.isArray(projects) ? projects : []).find((p) => p.id === projectId);
  if (!project) throw { status: 404, message: `Project not found: ${projectId}` };
  if (!Array.isArray(project.agentIds) || !project.agentIds.includes(agentId)) {
    throw { status: 400, message: `agentId "${agentId}" is not on this project's team [${(project.agentIds || []).join(", ")}]` };
  }
  let resolvedAgentId = agentId || null;
  let resolvedAgentName = agentName || null;

  // 2. Create the subtask (backlog), then flip to running.
  const created = await cli([
    "task", "create", "--project", projectId, "--title", title, "--actor", "delegate",
    "--description", description, "--priority", priority,
    ...(resolvedAgentId ? ["--agent-id", resolvedAgentId] : []),
    ...(resolvedAgentName ? ["--agent-name", resolvedAgentName] : []),
    ...(modelId ? ["--model-id", modelId] : []),
    ...(modelProviderID ? ["--model-provider", modelProviderID] : []),
    ...(parentSessionId ? ["--parent-session-id", parentSessionId] : []),
    ...(result ? ["--result", result] : []),
    ...(resultContext ? ["--result-context", resultContext] : []),
    ...(featureId ? ["--feature", String(featureId).trim()] : []),
  ]);
  const tid = created.id;
  await cli(["task", "move", tid, "running", "--actor", "delegate"]);

  // Isolation: a feature task works in the feature worktree (shared with the
  // other steps). A plain task gets its own worktree.
  const worktree = featureId
    ? { path: created.worktreePath || null, branch: created.worktreeBranch || null, base: null, feature: true }
    : await createTaskWorktree(tid);
  const workDir = worktree?.path || project.path;

  const base = ((loadServerCreds().url || "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
  const apiBase = base.endsWith("/api") ? base : `${base}/api`;
  const stored = loadServerCreds();
  const password = stored.password || "";
  const H = { "Content-Type": "application/json", ...opencodeAuthHeaders(password) };

  try {
    // 3. Spawn the teammate session in the project directory.
    const sessBody = {};
    if (resolvedAgentId || resolvedAgentName) sessBody.agent = resolvedAgentId || resolvedAgentName;
    if (modelId && modelProviderID) sessBody.model = { providerID: modelProviderID, id: modelId };
    if (workDir) sessBody.location = { directory: workDir };
    const sessRes = await fetch(`${apiBase}/session`, { method: "POST", headers: H, body: JSON.stringify(sessBody) });
    if (!sessRes.ok) {
      const t = await sessRes.text().catch(() => "");
      throw new Error(`session create failed (HTTP ${sessRes.status}) — ${t.slice(0, 300)}`);
    }
    const sessJson = await sessRes.json();
    const session = sessJson?.data ?? sessJson;
    if (!session?.id) throw new Error("session create returned no id");
    await cli(["task", "update", tid, "--actor", "delegate", "--session-id", session.id,
      ...(resolvedAgentId ? ["--agent-id", resolvedAgentId] : []),
      ...(resolvedAgentName ? ["--agent-name", resolvedAgentName] : []),
      "--startup-phase", "ready"]);

    // 4. Send the work prompt — board follows session outcome; last assistant message is captured as result automatically.
    const styleGuide = loadStyleGuide();
    const prompt =
      `You are ${resolvedAgentName || resolvedAgentId || agentName || agentId || "a teammate"} executing a delegated subtask. Complete it end-to-end in ${workDir || project.path || project.name}.\n` +
      worktreePromptLines(worktree) +
      `Task id: ${tid}\nProject id: ${projectId}\nTask: ${title}\nDescription: ${description || "(none)"}\nSession id: ${session.id} (pass as parentSessionId when you create/delegate follow-up tasks).\n\n` +
      `Before finishing, verify every acceptance criterion and required check. End with KANBAN_TASK_COMPLETE only when all are met; otherwise explain what remains and end with KANBAN_TASK_INCOMPLETE. A successful session alone does not prove completion. Do NOT call kanban_update_status or PATCH the task status yourself. ` +
      (styleGuide ? `\n${styleGuide}\n` : "") +
      `Fire-and-forget: the delegator already returned. Call kanban_task_heartbeat on your task id every couple of minutes with --progress so the watchdog sees you alive.`;
    const pRes = await fetch(`${apiBase}/session/${session.id}/prompt`, {
      method: "POST", headers: H, body: JSON.stringify({ text: prompt }),
    });
    if (!pRes.ok) {
      const t = await pRes.text().catch(() => "");
      throw new Error(`send prompt failed (HTTP ${pRes.status}) — ${t.slice(0, 300)}`);
    }

    if (!(wait === true || wait === "true")) {
      return { task: await cli(["task", "show", tid]), sessionId: session.id, waited: false, ...(worktree ? { worktree } : {}) };
    }

    // 5. Block until done/blocked (or timeout) — the "tool call return".
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      await sleep(interval);
      const cur = await cli(["task", "show", tid]);
      if (cur.status === "done" || cur.status === "blocked") {
        // wait:true hands the result back to THIS caller as the tool return, so
        // it is already in the parent's context — stamp it delivered or the
        // notifier would push the same result into the parent a second time.
        if (parentSessionId) {
          await cli(["task", "notify-mark", tid, "--actor", "delegate"]).catch(() => null);
        }
        return { task: cur, sessionId: session.id, waited: true, ...(worktree ? { worktree } : {}) };
      }
      if (Date.now() >= deadline) {
        throw { status: 504, message: `delegate timed out after ${timeout}s — task ${tid} still ${cur.status}`, task: cur, sessionId: session.id };
      }
    }
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) throw err;
    // Spawn/prompt failure → park the subtask as blocked so the board shows it.
    // Pass the full cause chain (message + cause) to the caller: a plain
    // 502 without the root cause made blocked tasks unanalyzable.
    const cause = describeErrorCause(err);
    let cur = null;
    try {
      cur = await cli(["task", "update", tid, "--actor", "delegate", "--status", "blocked",
        "--startup-phase", "error", "--startup-error", cause.slice(0, 500)]);
    } catch { /* keep original error */ }
    throw { status: 502, message: cause, task: cur };
  }
}

// Start/retry a task that already exists. Resolve and validate the configured
// teammate + model before changing task state; this endpoint never creates a card.
async function startExistingTask(taskId, opts = {}) {
  const task = await cli(["task", "show", taskId]);
  if (!task || !task.id) throw { status: 404, message: `Task not found: ${taskId}` };
  if (task.status === "running") throw { status: 409, message: "Task is already running", task };
  const projects = await cli(["project", "list", "--json"]);
  const project = (Array.isArray(projects) ? projects : []).find((p) => p.id === task.projectId);
  if (!project) throw { status: 404, message: `Project not found: ${task.projectId}` };

  const agentId = opts.agentId || task.agentId;
  if (!agentId) throw { status: 400, message: "agentId required; configure/select a teammate before starting this task" };
  const team = Array.isArray(project.agentIds) ? project.agentIds : [];
  if (!team.includes(agentId)) throw { status: 400, message: `agentId "${agentId}" is not on this project's team [${team.join(", ")}]` };

  const modelId = opts.modelId || task.modelId;
  const modelProviderID = opts.modelProviderID || task.modelProviderID;
  if (!modelId || !modelProviderID) throw { status: 400, message: "modelId and modelProviderID are required; select a configured model before starting this task" };
  await validateTaskModel(task.projectId, modelProviderID, modelId);

  const agentName = opts.agentName || task.agentName || agentId;
  const description = task.description || "";
  const projectPath = project.path || "";
  const base = ((loadServerCreds().url || "http://127.0.0.1:4099") + "").replace(/\/+$/, "");
  const apiBase = base.endsWith("/api") ? base : `${base}/api`;
  const H = { "Content-Type": "application/json", ...opencodeAuthHeaders(loadServerCreds().password || "") };

  // Keep the existing task identity and result history; only reset run fields.
  await cli(["task", "update", taskId, "--actor", "delegate", "--agent-id", agentId,
    "--agent-name", agentName, "--model-id", modelId, "--model-provider", modelProviderID,
    "--result", "", "--result-context", "", "--startup-error", ""]);
  await cli(["task", "move", taskId, "running", "--actor", "delegate"]);
  // Isolation: the task works in its own git worktree.
  const worktree = await createTaskWorktree(taskId);
  const workDir = worktree?.path || projectPath;
  try {
    const created = await fetch(`${apiBase}/session`, {
      method: "POST", headers: H,
      body: JSON.stringify({ agent: agentId, model: { id: modelId, providerID: modelProviderID }, ...(workDir ? { location: { directory: workDir } } : {}) }),
    });
    if (!created.ok) throw new Error(`session create failed (HTTP ${created.status}) — ${(await created.text()).slice(0, 300)}`);
    const payload = await created.json();
    const session = payload?.data ?? payload;
    if (!session?.id) throw new Error("session create returned no id");
    await cli(["task", "update", taskId, "--actor", "delegate", "--session-id", session.id,
      "--startup-phase", "ready"]);
    const styleGuide = loadStyleGuide();
    const prompt = `You are ${agentName} executing an existing Kanban task. Complete it end-to-end in ${workDir || projectPath || project.name}.\n${worktreePromptLines(worktree)}Task id: ${taskId}\nProject id: ${task.projectId}\nTask: ${task.title}\nDescription: ${description || "(none)"}\nSession id: ${session.id}\n\nReview every acceptance criterion and required check before reporting. End with KANBAN_TASK_COMPLETE only when all are satisfied and verified. Otherwise explain what remains and end with KANBAN_TASK_INCOMPLETE. Do not change the task status manually.${styleGuide ? `\n${styleGuide}\n` : ""}`;
    const prompted = await fetch(`${apiBase}/session/${encodeURIComponent(session.id)}/prompt`, {
      method: "POST", headers: H, body: JSON.stringify({ text: prompt }),
    });
    if (!prompted.ok) throw new Error(`send prompt failed (HTTP ${prompted.status}) — ${(await prompted.text()).slice(0, 300)}`);
    return { task: await cli(["task", "show", taskId]), sessionId: session.id, ...(worktree ? { worktree } : {}) };
  } catch (error) {
    const message = describeErrorCause(error);
    await cli(["task", "update", taskId, "--actor", "delegate", "--status", "blocked",
      "--startup-phase", "error", "--startup-error", message.slice(0, 500),
      "--result-context", message.slice(0, 4000)]).catch(() => null);
    throw { status: 502, message, task: await cli(["task", "show", taskId]).catch(() => task) };
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

// How to reach this server from a tool. Agents repeatedly lost turns to the
// self-signed cert in https mode (Node fetch throws "self signed certificate",
// PowerShell has no -SkipCertificateCheck on Invoke-RestMethod), so name the
// working call per runtime. `socket.encrypted` is the ground truth — the
// KANBAN_HTTPS env var is absent when the server was started some other way.
function accessNote(req) {
  const tls = Boolean(req?.socket?.encrypted);
  if (!tls) {
    return { base: "http://localhost:3001", selfSigned: false, tips: ["Plain HTTP. Any runtime works: fetch, Invoke-RestMethod, curl."] };
  }
  return {
    base: "https://localhost:3001",
    selfSigned: true,
    tips: [
      'https://localhost:3001 uses a SELF-SIGNED certificate. Do NOT use https:// with Node fetch (throws "self signed certificate") and do NOT use plain http:// against it (socket closes with "Empty reply from server").',
      "Node fetch / PowerShell Invoke-RestMethod / curl without -k: use the plain-HTTP bridge http://localhost:3002 - same routes, started by `npm run dev:https`.",
      "curl.exe against the board directly: always pass -k (curl.exe -k -sS ...). Note Invoke-RestMethod has NO -SkipCertificateCheck parameter; that belongs to Invoke-WebRequest on PowerShell 7.4+.",
    ],
  };
}

// JSON catalogue (machine-readable route list). Served at ?format=json
// so /api/kanban/docs itself can be the human try-it-out page.
function kanbanDocs(req) {
  return {
    ok: true,
    base: "/api/kanban",
    auth: "none - local store only. Other /api/* paths proxy to OpenCode :4096 and need Basic opencode:<password>.",
    access: accessNote(req),
    routes: [
      { method: "GET", path: "/api/kanban/tasks", query: "projectId?, status=backlog|running|done|blocked?", returns: "Task[]" },
      { method: "GET", path: "/api/kanban/tasks/:id", returns: "Task (404 when missing)" },
      { method: "POST", path: "/api/kanban/tasks/:id/start", body: "agentId?, agentName?, modelId?, modelProviderID? (missing values use the task's saved configuration); starts/retries this existing task without creating a duplicate", returns: "{task,sessionId}" },
      { method: "POST", path: "/api/kanban/tasks", body: "projectId*, title*, description?, status?, priority?, id?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?, parentSessionId?, result?, resultContext?, blockedByTaskIds?[]", returns: "Task" },
      { method: "PATCH", path: "/api/kanban/tasks/:id", body: "title?, description?, status?, priority?, agentId?, agentName?, sessionId?, modelId?, modelProviderID?, startupPhase?, startupError?, parentSessionId?, result?, resultContext?, blockedByTaskIds?[] (array replaces, [] clears)", returns: "Task" },
      { method: "GET", path: "/api/kanban/tasks/:id/dependencies", returns: "{id, status, blockedByTaskIds[], predecessors[{id,exists,status,title,done}], dependents[], ready}" },
      { method: "GET", path: "/api/kanban/tasks/:id/worktree", returns: "{taskId, path, branch, state, note}" },
      { method: "POST", path: "/api/kanban/tasks/:id/worktree", returns: "{ok, path, branch, base, reused} — own git worktree for this task" },
      { method: "POST", path: "/api/kanban/tasks/:id/worktree/merge", body: "target?, cleanup?", returns: "{ok, merged, conflict, files[], error}" },
      { method: "DELETE", path: "/api/kanban/tasks/:id/worktree", returns: "{ok, removed, path, branch, error}" },
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
      { method: "GET", path: "/api/kanban/server", returns: "Environment-managed {url, hasPassword}" },
      { method: "POST", path: "/api/kanban/delegate", body: "projectId*, title*, agentId*, description?, priority?, agentName?, modelId?, modelProviderID?, parentSessionId?, timeoutSec?=600, pollMs?=3000, wait?=false — creates a subtask for a teammate and starts it NOW. Fire-and-forget by default (returns {task, sessionId, waited:false} immediately). Pass wait:true to block until done/blocked.", returns: "{task, sessionId, waited}" },
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
      parentSessionId: { type: ["string", "null"] },
      result: { type: ["string", "null"] },
      resultContext: { type: ["string", "null"] },
      blockedByTaskIds: { type: "array", items: { type: "string", format: "uuid" }, description: "Predecessor task ids that must be done first. Self-references, unknown ids, foreign-project ids and cycles are rejected with 400." },
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
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "title"], properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, id: { type: "string" }, agentId: { type: "string" }, agentName: { type: "string" }, sessionId: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, startupPhase: { type: "string" }, startupError: { type: "string" }, parentSessionId: { type: "string" }, result: { type: "string" }, resultContext: { type: "string" }, blockedByTaskIds: { type: "array", items: { type: "string" } } } } } } },
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
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, agentId: { type: "string" }, agentName: { type: "string" }, sessionId: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, startupPhase: { type: "string" }, startupError: { type: "string" }, parentSessionId: { type: "string" }, result: { type: "string" }, resultContext: { type: "string" }, blockedByTaskIds: { type: "array", items: { type: "string" } } } } } } },
          responses: { 200: { description: "Task", content: { "application/json": { schema: taskSchema } } }, 400: { description: "invalid dependencies (unknown id, self-reference, cycle)", content: { "application/json": { schema: errSchema } } }, 404: { description: "not found", content: { "application/json": { schema: errSchema } } } },
        },
        delete: {
          summary: "Delete task",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{ok,deleted}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/tasks/{id}/start": {
        post: {
          summary: "Start or retry an existing task without creating a duplicate",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { agentId: { type: "string" }, agentName: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" } } } } } },
          responses: { 200: { description: "Existing task started", content: { "application/json": { schema: { type: "object" } } } }, 400: { description: "Missing or invalid team agent/model", content: { "application/json": { schema: errSchema } } }, 404: { description: "task/project not found", content: { "application/json": { schema: errSchema } } }, 409: { description: "task already running", content: { "application/json": { schema: errSchema } } } },
        },
      },
      "/api/kanban/tasks/{id}/dependencies": {
        get: {
          summary: "Dependency relations of a task (predecessors, dependents, readiness)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{id,status,blockedByTaskIds,predecessors,dependents,ready}", content: { "application/json": { schema: { type: "object" } } } }, 404: { description: "not found", content: { "application/json": { schema: errSchema } } } },
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
          summary: "Create + start a subtask for a teammate (fire-and-forget by default; wait:true blocks until done)",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "title", "agentId"], properties: { projectId: { type: "string" }, title: { type: "string" }, agentId: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, agentName: { type: "string" }, modelId: { type: "string" }, modelProviderID: { type: "string" }, parentSessionId: { type: "string" }, result: { type: "string" }, resultContext: { type: "string" }, timeoutSec: { type: "integer", default: 600 }, pollMs: { type: "integer", default: 3000 }, wait: { type: "boolean", default: false } } } } } },
          responses: { 200: { description: "{task, sessionId, waited}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/message_to": {
        post: {
          summary: "Follow-up in the SAME subtask session (no new task) — waits for next assistant message",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { sessionId: { type: "string" }, taskId: { type: "string" }, text: { type: "string" }, timeoutSec: { type: "integer", default: 120 }, pollMs: { type: "integer", default: 1500 } } } } } },
          responses: { 200: { description: "{sessionId, taskId, resultText, resultTruncated, messageId, waited}", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/api/kanban/server": {
        get: {
          summary: "Stored OpenCode creds (url + hasPassword, never the secret)",
          responses: { 200: { description: "{url,hasPassword}", content: { "application/json": { schema: { type: "object" } } } } },
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
      startReconciler();
      // Before the "/api" proxy: /api/kanban/* is the local store,
      // everything else under /api still forwards to OpenCode :4096.
      server.middlewares.use("/api/kanban", async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const parts = url.pathname.split("/").filter(Boolean);
        const q = url.searchParams;
        try {
          if (await attachmentRoute(req, res, url)) return;
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
          // POST /api/kanban/tasks/:id/start {agentId?,modelId?,modelProviderID?}
          // → starts/retries the existing task; never creates a replacement.
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "start") {
            const b = await readBody(req);
            return json(res, 200, await startExistingTask(parts[1], b));
          }
          // POST /api/kanban/tasks {projectId,title,...} → Task
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 1) {
            const b = await readBody(req);
            if (!b.projectId || !b.title)
              return json(res, 400, { ok: false, error: "projectId and title required" });
            await validateTaskModel(b.projectId, b.modelProviderID, b.modelId);
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
            if (b.parentSessionId !== undefined && b.parentSessionId !== null) argv.push("--parent-session-id", String(b.parentSessionId));
            if (b.result !== undefined && b.result !== null) argv.push("--result", String(b.result));
            if (b.resultContext !== undefined && b.resultContext !== null) argv.push("--result-context", String(b.resultContext));
             if (b.acceptanceCriteria !== undefined && b.acceptanceCriteria !== null) argv.push("--acceptance-criteria", String(b.acceptanceCriteria));
             if (b.kind) argv.push("--kind", String(b.kind));
             if (b.cycleIntervalSec !== undefined && b.cycleIntervalSec !== null) argv.push("--cycle-interval-sec", String(b.cycleIntervalSec));
             if (b.dueDate !== undefined && b.dueDate !== null) argv.push("--due-date", String(b.dueDate));
            if (b.blockedByTaskIds !== undefined && b.blockedByTaskIds !== null) {
              argv.push("--blocked-by", Array.isArray(b.blockedByTaskIds) ? b.blockedByTaskIds.join(",") : String(b.blockedByTaskIds));
            }
            return json(res, 200, await cli(argv));
          }
          // PATCH /api/kanban/tasks/:id {title?,status?,...} → Task
          if (req.method === "PATCH" && parts[0] === "tasks" && parts.length === 2) {
            const b = await readBody(req);
            if (b.modelId !== undefined || b.modelProviderID !== undefined) {
              const existing = await cli(["task", "show", parts[1]]);
              await validateTaskModel(existing.projectId, b.modelProviderID, b.modelId);
            }
            const argv = ["task", "update", parts[1], "--actor", "board"];
            for (const [flag, key] of [
              ["--title", "title"], ["--description", "description"],
              ["--status", "status"], ["--priority", "priority"],
              ["--agent-id", "agentId"], ["--agent-name", "agentName"],
              ["--session-id", "sessionId"], ["--model-id", "modelId"],
              ["--model-provider", "modelProviderID"],
              ["--startup-phase", "startupPhase"], ["--startup-error", "startupError"],
              ["--parent-session-id", "parentSessionId"],
              ["--result", "result"], ["--result-context", "resultContext"],
               ["--acceptance-criteria", "acceptanceCriteria"],
                ["--kind", "kind"], ["--cycle-interval-sec", "cycleIntervalSec"], ["--due-date", "dueDate"],
                ["--worktree-note", "worktreeNote"],
            ]) {
              if (key === "dueDate" && b[key] === null) argv.push(flag, "");
              else if (b[key] !== undefined && b[key] !== null) argv.push(flag, String(b[key]));
            }
            // blockedByTaskIds: array replaces the list, [] clears it (server validates).
            if (b.blockedByTaskIds !== undefined && b.blockedByTaskIds !== null) {
              argv.push("--blocked-by", Array.isArray(b.blockedByTaskIds) ? b.blockedByTaskIds.join(",") : String(b.blockedByTaskIds));
            }
            return json(res, 200, await cli(argv));
          }
          // GET /api/kanban/features?projectId= → Feature[]
          if (req.method === "GET" && parts[0] === "features" && parts.length === 1) {
            const argv = ["feature", "list"];
            const pid = q.get("projectId");
            if (pid) argv.push("--project", String(pid));
            return json(res, 200, await cli(argv));
          }
          // GET /api/kanban/features/:id → Feature with its tasks
          if (req.method === "GET" && parts[0] === "features" && parts.length === 2) {
            return json(res, 200, await cli(["feature", "show", parts[1]]));
          }
          // POST /api/kanban/features {projectId*, title*, description?} → Feature (worktree + branch)
          if (req.method === "POST" && parts[0] === "features" && parts.length === 1) {
            const b = await readBody(req);
            if (!b.projectId) return json(res, 400, { ok: false, error: "projectId required" });
            if (!b.title) return json(res, 400, { ok: false, error: "title required" });
            const argv = ["feature", "create", "--project", String(b.projectId),
              "--title", String(b.title), "--actor", "board"];
            if (b.description) argv.push("--description", String(b.description));
            if (b.base) argv.push("--base", String(b.base));
            return json(res, 200, await cli(argv));
          }
          // POST /api/kanban/features/:id/merge → merge the feature branch into the project branch
          if (req.method === "POST" && parts[0] === "features" && parts.length === 3 && parts[2] === "merge") {
            const b = await readBody(req);
            const argv = ["feature", "merge", parts[1]];
            if (b?.target) argv.push("--target", String(b.target));
            return json(res, 200, await cli(argv));
          }
          // DELETE /api/kanban/features/:id → {ok:true,deleted}
          if (req.method === "DELETE" && parts[0] === "features" && parts.length === 2) {
            return json(res, 200, await cli(["feature", "delete", parts[1], "--actor", "board"]));
          }
          // GET /api/kanban/tasks/:id/dependencies → {id, blockedByTaskIds, predecessors, dependents, ready}
          if (req.method === "GET" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "dependencies") {
            return json(res, 200, await cli(["task", "deps", parts[1]]));
          }
          // GET /api/kanban/tasks/:id/worktree → {path, branch, state, note}
          if (req.method === "GET" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "worktree") {
            const task = await cli(["task", "show", parts[1]]);
            return json(res, 200, {
              taskId: task.id,
              path: task.worktreePath ?? null,
              branch: task.worktreeBranch ?? null,
              state: task.worktreeState ?? null,
              note: task.worktreeNote ?? null,
            });
          }
          // POST /api/kanban/tasks/:id/worktree → create the worktree of a task
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "worktree") {
            return json(res, 200, await cli(["worktree", "create", parts[1]]));
          }
          // POST /api/kanban/tasks/:id/worktree/merge → merge the task branch into the project branch
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 4 && parts[2] === "worktree" && parts[3] === "merge") {
            const b = await readBody(req);
            const argv = ["worktree", "merge", parts[1]];
            if (b?.target) argv.push("--target", String(b.target));
            if (b?.cleanup) argv.push("--cleanup");
            return json(res, 200, await cli(argv));
          }
          // DELETE /api/kanban/tasks/:id/worktree → remove the worktree folder
          if (req.method === "DELETE" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "worktree") {
            return json(res, 200, await cli(["worktree", "remove", parts[1], "--force"]));
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
            // Allowed models — one scalar flag per entry (shell-quoting proof).
            // An empty list means "no restriction", which create takes as default anyway.
            if (b.allowedModels !== undefined && b.allowedModels !== null) {
              const list = Array.isArray(b.allowedModels) ? b.allowedModels : [];
              if (list.length === 0) argv.push("--clear-allowed-models");
              else for (const m of list) argv.push("--allowed-model", String(m));
            }
            for (const a of b.agentIds || []) argv.push("--agent-id", a);
            return json(res, 200, await cli(argv));
          }
          // PATCH /api/kanban/projects/:id {name?,folder?,path?,gitUrl?,gitBranch?,description?,agentIds?,allowedModels?} → Project
          if ((req.method === "PATCH" || req.method === "PUT") && parts[0] === "projects" && parts.length === 2) {
            const b = await readBody(req);
            const argv = ["project", "update", parts[1], "--actor", "board"];
            if (b.name !== undefined) argv.push("--name", String(b.name));
            if (b.folder !== undefined) argv.push("--folder", String(b.folder));
            else if (b.path !== undefined) argv.push("--path", String(b.path));
            if (b.gitUrl !== undefined) argv.push("--git-url", String(b.gitUrl || ""));
            if (b.gitBranch !== undefined) argv.push("--git-branch", String(b.gitBranch || "main"));
            if (b.description !== undefined) argv.push("--description", String(b.description));
            // Allowed models — an empty list clears the restriction (server stores '[]').
            if (b.allowedModels !== undefined && b.allowedModels !== null) {
              const list = Array.isArray(b.allowedModels) ? b.allowedModels : [];
              if (list.length === 0) argv.push("--clear-allowed-models");
              else for (const m of list) argv.push("--allowed-model", String(m));
            }
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
              await validateTaskModel(b.projectId, b.modelProviderID, b.modelId);
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
          // POST /api/kanban/tasks/:id/result {result*, resultContext?} → Task (dedicated result endpoint, does not touch description)
          if (req.method === "POST" && parts[0] === "tasks" && parts.length === 3 && parts[2] === "result") {
            const b = await readBody(req);
            if (b.result == null) return json(res, 400, { ok: false, error: "result required" });
            const argv = ["task", "update", parts[1], "--actor", "board", "--result", String(b.result)];
            if (b.resultContext !== undefined && b.resultContext !== null) argv.push("--result-context", String(b.resultContext));
            return json(res, 200, await cli(argv));
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
          // Vite injects Basic opencode:<password> from the root .env.
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
                res.setHeader("X-Accel-Buffering", "no");
                if (typeof res.flushHeaders === "function") res.flushHeaders();
                const reader = up.body.getReader();
                const decoder = new TextDecoder();
                // The request is complete before the SSE body starts. Its
                // `close` event can fire while the client still reads the
                // response, so watch the response for client disconnects.
                res.on("close", () => {
                  if (!res.writableEnded) { try { reader.cancel(); } catch {} }
                });
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
              if (!up.ok && up.status >= 500) {
                // Infra self-healing: upstream 5xx (OpenCode down/pruned) →
                // backlog fix task. Best-effort; projectId from referrer is not
                // available here, so attach to the first project that owns a
                // task with this sessionId (session path match).
                (async () => {
                  try {
                    const m = ocPath.match(/\/session\/([\w-]+)/);
                    if (!m) return;
                    const sid = m[1];
                    const tasks = await cli(["task", "list"]).catch(() => []);
                    const owner = Array.isArray(tasks) && tasks.find((t) =>
                      (t.sessionId || t.session_id) === sid && !/^Fix \(infra\)/.test(t.title || ""));
                    if (!owner) return;
                    await ensureInfraFixTask(owner.projectId || owner.project_id,
                      `Fix (infra): OpenCode ${up.status} on session ${sid}`,
                      `Upstream ${req.method} ${ocPath} returned HTTP ${up.status}: ${(text || "").slice(0, 300)}\nOrigin task: ${owner.title} (${owner.id}). Check OpenCode server on :4099 and password in Server settings.`);
                  } catch { /* best-effort */ }
                })();
              }
              res.statusCode = up.status;
              const ct = up.headers.get("content-type");
              res.setHeader("Content-Type", ct || "application/json");
              return res.end(text);
            } catch (err) {
              return json(res, 502, { ok: false, error: `OpenCode proxy failed: ${String(err?.message || err).slice(0, 300)}` });
            }
          }
          // GET /api/kanban/server → report environment-managed OpenCode state.
          if (parts[0] === "server" && parts.length === 1) {
            if (req.method === "GET") return json(res, 200, { url: loadServerCreds().url, hasPassword: !!loadServerCreds().password });
            return json(res, 405, { ok: false, error: "Server settings are managed by the root .env file." });
          }
          // POST /api/kanban/server/test → test environment-managed credentials.
          if (parts[0] === "server" && parts.length === 2 && parts[1] === "test" && req.method === "POST") {
            const stored = loadServerCreds();
            const tryUrl = (stored.url || "http://127.0.0.1:4099").replace(/\/+$/, "");
            const tryApi = tryUrl.endsWith("/api") ? tryUrl : `${tryUrl}/api`;
            try {
              const up = await fetch(`${tryApi}/agent`, { headers: opencodeAuthHeaders(stored.password) });
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
            if (q.get("format") === "json") return json(res, 200, kanbanDocs(req));
            return html(res, 200, kanbanDocsPage());
          }
          // GET /api/kanban/openapi.json → OpenAPI 3.0 spec for the local store
          if (req.method === "GET" && parts[0] === "openapi.json" && parts.length === 1) {
            return json(res, 200, kanbanOpenApi());
          }
          // GET /api/kanban/prompts/final-message-style → editable style guide (markdown).
          if (req.method === "GET" && parts[0] === "prompts" && parts.length === 2) {
            try {
              const text = await fsp.readFile(join(HERE, "prompts", parts[1]), "utf8");
              res.statusCode = 200;
              res.setHeader("Content-Type", "text/markdown; charset=utf-8");
              return res.end(text);
            } catch {
              return json(res, 404, { ok: false, error: "prompt not found" });
            }
          }
          return json(res, 404, { ok: false, error: "unknown kanban route" });
        } catch (err) {
          const msg = String(err?.stderr || err?.message || err);
          return json(res, cliErrorStatus(msg), { ok: false, error: msg });
        }
      });
    },
  };
}

export default defineConfig({
  // Mic on Android needs HTTPS: run `npm run dev:https` (or KANBAN_HTTPS=1)
  // to serve with a self-signed cert. Accept the warning on the phone once.
  plugins: [react(), tailwindcss(), ...(process.env.KANBAN_HTTPS ? [basicSsl()] : []), kanbanApi()],
  server: {
    host: "0.0.0.0",
    port: 3001,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4099",
    },
    hmr: {
      port: 3001,
      ...(process.env.KANBAN_HTTPS ? { protocol: "wss" } : {}),
    },
  },
});
