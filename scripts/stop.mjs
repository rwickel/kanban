// Stop the services `npm run dev` starts.
//
// `npm run dev` owns its children in one terminal, so Ctrl+C is usually enough.
// This script covers the other cases: a dev stack left running in the
// background, a stale board from a crashed run, or services started by hand.
//
// It never touches the shared OpenCode service (the one hosting your current
// session) unless you pass --all, because killing that ends every open session.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { BRIDGE_PORT, KANBAN_PORT } from "./http-bridge.mjs";

const OPENCODE_SERVE_PORT = 4099;

// Port of the shared background service this tool must not kill by accident.
const SHARED_SERVICE_PORT = 45278;

// Command-line markers, so an already-dead port still finds its process.
const MARKERS = [
  { name: "kanban board (vite)", match: /vite(\.js)?\b.*--port\s*3001|vite(\.js)?\b/i },
  // Anchored to a path segment at the end of the command, so a process that
  // merely mentions the script (e.g. `--note http-bridge.mjs`) is not killed.
  { name: "plain-HTTP bridge", match: /[\\/]http-bridge\.mjs"?\s*$/ },
  { name: "opencode serve", match: /opencode(\.exe)?\s+serve\b.*--port\s*4099/ },
];

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
    // taskkill writes "process not found" to stderr for children that already
    // died with their parent; that is noise, not a failure.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Snapshot of every process as {pid, ppid, name, cmd}. */
export function listProcesses() {
  const raw =
    process.platform === "win32"
      ? run("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ])
      : run("ps", ["-eo", "pid=,ppid=,args="]);

  let parsed;
  if (process.platform === "win32") {
    const rows = JSON.parse(raw || "[]");
    parsed = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: String(r.Name || ""),
      cmd: String(r.CommandLine || ""),
    }));
  } else {
    parsed = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: "", cmd: m[3] } : null;
      })
      .filter(Boolean);
  }
  return parsed.filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

// One netstat read answers every port question in a run.
let netstatCache = null;
export function clearPortCache() {
  netstatCache = null;
}

/** Trailing port of a netstat address, ignoring IPv6 brackets. */
function portOf(address) {
  const s = String(address || "");
  const i = s.lastIndexOf(":");
  return i < 0 ? NaN : Number(s.slice(i + 1));
}

/** PIDs listening on a TCP port. Empty when the port is free. */
export function pidsOnPort(port) {
  if (process.platform !== "win32") return [];
  // netstat parses in milliseconds; Get-NetTCPConnection can take seconds, and
  // this runs once per port per invocation.
  try {
    netstatCache ??= run("netstat", ["-ano", "-p", "tcp"]);
    const pids = new Set();
    for (const line of netstatCache.split(/\r?\n/)) {
      // "  TCP  0.0.0.0:3001  0.0.0.0:0  LISTENING  1234"
      // The state column is localized (a German netstat prints "ABHOEREN"), so
      // never match on it. A listening socket is identified structurally: bound
      // to our port, with a peer port of 0.
      const f = line.trim().split(/\s+/);
      if (f.length < 5 || !/^TCP$/i.test(f[0])) continue;
      if (portOf(f[1]) !== port || portOf(f[2]) !== 0) continue;
      const pid = Number(f[4]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** Our own pid plus every ancestor, which must never be killed. */
export function protectedPids(procs, selfPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const keep = new Set([selfPid]);
  let cursor = byPid.get(selfPid);
  // `keep` doubles as the visited set: a pid re-encountered means the ppid
  // chain is cyclic, and walking it again would never terminate.
  while (cursor?.ppid && !keep.has(cursor.ppid)) {
    keep.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return keep;
}

/**
 * Pick the processes to stop: anything holding a dev port, plus anything whose
 * command line matches a dev marker. Protected pids and the shared service are
 * always excluded unless `includeShared` is set.
 */
export function selectTargets({ procs, ports, sharedPort = SHARED_SERVICE_PORT, selfPid = process.pid, includeShared = false }) {
  const keep = protectedPids(procs, selfPid);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const portPids = new Set(ports.flatMap((port) => pidsOnPort(port)));
  const sharedPids = includeShared ? new Set() : new Set(pidsOnPort(sharedPort));

  const chosen = new Map();
  for (const pid of portPids) {
    if (keep.has(pid) || sharedPids.has(pid)) continue;
    chosen.set(pid, byPid.get(pid)?.name || `pid ${pid}`);
  }
  for (const proc of procs) {
    if (keep.has(proc.pid) || sharedPids.has(proc.pid)) continue;
    const hit = MARKERS.find((marker) => marker.match.test(proc.cmd));
    // Never match our own stop script: it references the marker names.
    if (hit && !/stop\.mjs/.test(proc.cmd)) chosen.set(proc.pid, hit.name);
  }
  return [...chosen].map(([pid, name]) => ({ pid, name }));
}

/** Children of a pid, deepest first, so killing a parent never orphans a child. */
function descendants(procs, root) {
  const byParent = new Map();
  for (const p of procs) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p.pid);
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      walk(child);
      out.push(child);
    }
  };
  walk(root);
  return out;
}

function kill(pid) {
  if (process.platform === "win32") {
    run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    process.kill(pid, "SIGKILL");
  }
}

export function stopServices({ includeShared = false, ports = [KANBAN_PORT, BRIDGE_PORT, OPENCODE_SERVE_PORT] } = {}) {
  const procs = listProcesses();
  const targets = selectTargets({ procs, ports, selfPid: process.pid, includeShared });
  const stopped = [];
  // Ports cannot have come free while we were killing, so a fresh read is needed.
  clearPortCache();

  // A parent and its child can both match a marker (npm shims, opencode.exe
  // wrapping a node process). Kill the outermost only, otherwise the second
  // taskkill fires against a pid that died with its parent and reports an error.
  const covered = new Set();
  for (const target of targets) {
    for (const pid of descendants(procs, target.pid)) covered.add(pid);
  }
  const outermost = targets.filter((t) => !covered.has(t.pid));

  for (const target of outermost) {
    // Leaf-first: stop the whole tree, then the process itself.
    const tree = [...descendants(procs, target.pid), target.pid];
    for (const pid of tree) {
      try {
        kill(pid);
      } catch {
        /* already gone */
      }
    }
    stopped.push({ ...target, pids: tree });
  }

  const stillUp = ports.filter((port) => pidsOnPort(port).length > 0);
  return { stopped, stillUp };
}

// pathToFileURL, not string concatenation: import.meta.url carries file:///
// on Windows while argv[1] does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const includeShared = process.argv.includes("--all");
  const { stopped, stillUp } = stopServices({ includeShared });

  if (stopped.length === 0) console.log("[stop] nothing running; already stopped.");
  for (const { name, pid, pids } of stopped) {
    console.log(`[stop] ${name} (pid ${pid}${pids.length > 1 ? ` + ${pids.length - 1} child` : ""})`);
  }
  if (stillUp.length) {
    console.error(`[stop] WARNING still listening: ${stillUp.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`[stop] done; ports ${[KANBAN_PORT, BRIDGE_PORT, OPENCODE_SERVE_PORT].join(", ")} are free.`);
  }
  if (!includeShared) console.log(`[stop] left the shared OpenCode service on ${SHARED_SERVICE_PORT} running (--all to include it).`);
}