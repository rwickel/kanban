// Shared core for the kanban OpenCode plugin (V2 API).
// Owns the CLI bridge helpers used by all plugin tools.
// The added capability over HTTP is the caller session id, taken from the tool context.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO = join(HERE, "..");
export const CLI = join(REPO, "server", "kanban.py");

// --- .env -----------------------------------------------------------------

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// File env first, so process env set by the host still wins.
const FILE_ENV = loadEnvFile(join(REPO, ".env"));

export function env(name, fallback = "") {
  const value = process.env[name] ?? FILE_ENV[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

export const DB =
  env("KANBAN_DB") ||
  join(env("KANBAN_DATA_DIR", join(REPO, ".kanban-data")), "kanban.db");

export const PYTHON = env("KANBAN_PYTHON", "python");

// --- style guide ----------------------------------------------------------

export function loadStyleGuide() {
  try {
    const p = join(REPO, "prompts", "final-message-style.md");
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

// --- CLI bridge -----------------------------------------------------------

/**
 * Run the board CLI.
 *
 * Async on purpose: a synchronous child process blocks the whole OpenCode
 * server event loop while it runs. A plugin that blocks the loop freezes
 * every session on the server, so the CLI runs in the background.
 */
export async function runCli(argv) {
  try {
    const { stdout } = await execFileAsync(PYTHON, [CLI, "--db", DB, ...argv], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, text: (stdout || "").trim() };
  } catch (err) {
    const msg = err?.stderr?.toString?.() || err?.message || "kanban CLI failed";
    return { ok: false, text: String(msg).trim() };
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- tool results ---------------------------------------------------------

export function textResult(text) {
  return { content: [{ type: "text", text: text || "{}" }] };
}

export function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

/** Non-zero CLI result becomes a thrown error so OpenCode marks the call failed. */
export function cliResult(res) {
  if (res.ok) return textResult(res.text);
  throw new Error(res.text || "kanban CLI failed");
}

/** Thrown failures keep the same payload the HTTP surface used to return. */
export function toolError(payload) {
  throw new Error(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- caller session -------------------------------------------------------

/**
 * An external bridge cannot see the caller session, so a delegate that omits
 * parentSessionId used to create a parentless task. A plugin tool receives the
 * real session id in its context, so use it as the default. An explicit value
 * always wins.
 */
export function callingSessionId(explicit, context) {
  const given = typeof explicit === "string" ? explicit.trim() : "";
  if (given) return given;
  const fromContext = typeof context?.sessionID === "string" ? context.sessionID.trim() : "";
  if (fromContext) return fromContext;
  const fromEnv = typeof process.env.OPENCODE_SESSION_ID === "string"
    ? process.env.OPENCODE_SESSION_ID.trim()
    : "";
  return fromEnv || null;
}

// --- Kanban API client ----------------------------------------------------

export const KANBAN_BRIDGE_PORT = 3002;

/**
 * Candidate board bases, most direct first.
 * `npm run dev:https` serves 3001 over TLS with a self-signed certificate, which
 * Node `fetch` rejects outright; plain http against a TLS listener just drops
 * the socket. The dev script mirrors https mode onto plain HTTP at 3002, so that
 * is the fallback that actually works from a plugin.
 */
export function kanbanBases() {
  const explicit = env("KANBAN_API_URL", "");
  if (explicit) return [explicit];
  return [`http://127.0.0.1:3001`, `http://127.0.0.1:${KANBAN_BRIDGE_PORT}`];
}

/** fetch against the first board base that accepts a connection. */
export async function kanbanFetch(path, init = {}) {
  let lastError;
  for (const base of kanbanBases()) {
    try {
      return await fetch(`${base}${path}`, init);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("kanban API unreachable");
}

// --- OpenCode server client ----------------------------------------------

export function serverCreds() {
  return {
    url: env("OPENCODE_SERVER_URL", "http://127.0.0.1:4099"),
    password: env("OPENCODE_SERVER_PASSWORD", ""),
  };
}

function basicAuth(password) {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
}

export function ocBase() {
  const base = serverCreds().url.replace(/\/+$/, "");
  return base.endsWith("/api") ? base : `${base}/api`;
}

export function ocH() {
  return { "Content-Type": "application/json", ...basicAuth(serverCreds().password) };
}

export async function ocMessages(apiBase, headers, sessionId, limit = 30) {
  const r = await fetch(
    `${apiBase}/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=desc`,
    { headers },
  );
  if (!r.ok) throw new Error(`fetch messages failed (HTTP ${r.status})`);
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j?.data ?? []);
  return Array.isArray(list) ? list : [];
}

export function ocMsgText(m) {
  if (!m || typeof m !== "object") return "";
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (m.info && typeof m.info.text === "string" && m.info.text.trim()) return m.info.text.trim();
  const pool = [
    ...(Array.isArray(m.content) ? m.content : []),
    ...(Array.isArray(m.parts) ? m.parts : []),
  ];
  return pool
    .filter(
      (p) =>
        p &&
        typeof p === "object" &&
        String(p.type || "").toLowerCase() === "text" &&
        typeof p.text === "string" &&
        p.text.trim(),
    )
    .map((p) => p.text.trim())
    .join("\n")
    .trim();
}

export function ocMsgRole(m) {
  if (!m || typeof m !== "object") return "";
  for (const k of ["role", "type"]) {
    if (typeof m[k] === "string" && ["assistant", "agent", "ai", "user", "system"].includes(m[k].toLowerCase())) {
      return m[k].toLowerCase();
    }
  }
  if (m.info && typeof m.info.role === "string") return m.info.role.toLowerCase();
  return "";
}

export function ocLastAssistant(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const role = ocMsgRole(m);
    if (role === "user" || role === "system") continue;
    const t = ocMsgText(m);
    if (t) return { text: t, id: m.id ?? m.messageID ?? null, raw: m };
  }
  return { text: "", id: null, raw: null };
}

// --- stall detection ------------------------------------------------------

function toolTimeMs(t) {
  if (t == null) return null;
  if (typeof t === "number") return t > 1e12 ? t : t * 1000;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Return the oldest stuck running tool of a message, or null.
 * A service such as "npm run dev" is not stuck: it returns completed promptly
 * and keeps the process alive, so no running tool survives to be flagged here.
 */
/**
 * Tools that block on a human instead of doing work. `question` waits for the
 * user to pick an option, so a long "running" state is correct behaviour — not
 * a stall. The watchdog must never interrupt these.
 */
const WAITING_TOOLS = new Set(["question", "ask", "permission", "confirm"]);

export function isWaitingTool(name) {
  return WAITING_TOOLS.has(String(name || "").toLowerCase());
}

export function findStuckTool(msg, stallMs = 90000) {
  if (!msg || typeof msg !== "object") return null;
  const pool = [
    ...(Array.isArray(msg.content) ? msg.content : []),
    ...(Array.isArray(msg.parts) ? msg.parts : []),
  ];
  const now = Date.now();
  let oldest = null;
  for (const p of pool) {
    if (!p || typeof p !== "object") continue;
    if (String(p.type || "").toLowerCase() !== "tool") continue;
    const st = p.state || {};
    if (String(st.status || "").toLowerCase() !== "running") continue;
    const toolName = p.name || st.name || "tool";
    // A waiting-for-human tool is idle by design, never a stall.
    if (isWaitingTool(toolName)) continue;
    if (toolTimeMs(p?.time?.completed) || toolTimeMs(st.completed) || toolTimeMs(st.completedAt)) continue;
    const ran =
      toolTimeMs(p?.time?.ran) ??
      toolTimeMs(st.ran) ??
      toolTimeMs(p?.time?.created) ??
      toolTimeMs(st.created);
    if (ran == null) continue;
    const age = now - ran;
    if (age > stallMs && (!oldest || age > oldest.ageMs)) {
      oldest = { name: toolName, id: p.id || st.id || null, ageMs: Math.round(age) };
    }
  }
  return oldest;
}

/**
 * The newest question a session is currently blocked on, or null.
 * Used to hand a subtask's pending question back to its parent session.
 */
export function findPendingQuestion(msg) {
  if (!msg || typeof msg !== "object") return null;
  const pool = [
    ...(Array.isArray(msg.content) ? msg.content : []),
    ...(Array.isArray(msg.parts) ? msg.parts : []),
  ];
  for (const p of pool) {
    if (!p || typeof p !== "object") continue;
    if (String(p.type || "").toLowerCase() !== "tool") continue;
    const st = p.state || {};
    const status = String(st.status || "").toLowerCase();
    if (status === "completed" || status === "error") continue;
    const toolName = p.name || st.name || "";
    if (!isWaitingTool(toolName)) continue;
    const input = st.input && typeof st.input === "object" ? st.input : {};
    const raw = Array.isArray(input.questions) ? input.questions : [];
    const questions = raw.map((q) => ({
      header: String(q?.header || "Question"),
      question: String(q?.question || ""),
      multiple: Boolean(q?.multiple),
      options: Array.isArray(q?.options)
        ? q.options.map((o) => ({ label: String(o?.label || ""), description: String(o?.description || "") }))
        : [],
    }));
    return { toolId: p.id || st.id || null, tool: toolName, questions };
  }
  return null;
}

export async function ocInterrupt(apiBase, headers, sessionId) {
  try {
    const r = await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      headers,
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ocPromptStop(apiBase, headers, sessionId) {
  // Belt and braces after interrupt: tell the agent to stop what it was doing.
  // Fire and forget, because the session is parked as blocked anyway.
  try {
    await fetch(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "STOP — your kanban task was marked blocked (stalled tool). Do not start new work. Acknowledge briefly.",
      }),
    });
  } catch {
    /* best effort */
  }
}