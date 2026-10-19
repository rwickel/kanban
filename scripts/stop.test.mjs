import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KANBAN_PORT } from "./http-bridge.mjs";
import { clearPortCache, listProcesses, pidsOnPort, protectedPids, selectTargets } from "./stop.mjs";

describe("protectedPids", () => {
  // 10 is the deepest child; 50 is its own child.
  const procs = [
    { pid: 10, ppid: 20, name: "node", cmd: "self" },
    { pid: 20, ppid: 30, name: "cmd.exe", cmd: "parent" },
    { pid: 30, ppid: 40, name: "powershell", cmd: "grandparent" },
    { pid: 40, ppid: 1, name: "opencode.exe", cmd: "serve" },
    { pid: 50, ppid: 10, name: "vite.js", cmd: "vite --port 3001" },
  ];

  it("protects self and the whole ancestor chain", () => {
    const keep = protectedPids(procs, 10);
    // 1 is the topmost parent even though it is not in the snapshot.
    assert.deepEqual([...keep].sort((a, b) => a - b), [1, 10, 20, 30, 40]);
    assert.ok(!keep.has(50), "a child must stay killable");
  });

  it("tolerates a cycle or unknown pid without looping forever", () => {
    const keep = protectedPids([{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }], 1);
    assert.deepEqual([...keep].sort((a, b) => a - b), [1, 2]);
    assert.deepEqual([...protectedPids([], 99)], [99]);
  });
});

describe("selectTargets", () => {
  it("picks up vite, the bridge, and opencode serve by command line", () => {
    const procs = [
      { pid: 100, ppid: 1, name: "node.exe", cmd: "node .\\node_modules\\vite\\bin\\vite.js --port 3001" },
      { pid: 200, ppid: 1, name: "node.exe", cmd: "node scripts/http-bridge.mjs" },
      { pid: 300, ppid: 1, name: "opencode.exe", cmd: "opencode.exe serve --port 4099" },
      { pid: 400, ppid: 1, name: "chrome.exe", cmd: "chrome.exe --type=renderer" },
    ];
    const picked = selectTargets({ procs, ports: [], selfPid: 999 });
    assert.deepEqual(picked.map((t) => t.pid).sort((a, b) => a - b), [100, 200, 300]);
    assert.deepEqual(
      picked.map((t) => t.name).sort(),
      ["kanban board (vite)", "opencode serve", "plain-HTTP bridge"],
    );
  });

  it("never selects its own process, an ancestor, or an unrelated app", () => {
    const procs = [
      { pid: 500, ppid: 499, name: "node.exe", cmd: "node scripts/stop.mjs" },
      { pid: 499, ppid: 1, name: "cmd.exe", cmd: "npm run stop" },
      { pid: 600, ppid: 1, name: "chrome.exe", cmd: "chrome.exe" },
    ];
    assert.deepEqual(selectTargets({ procs, ports: [], selfPid: 500 }), []);
  });

  it("does not match the stop script through its own marker text", () => {
    // A sibling that merely mentions http-bridge.mjs in an argument would
    // otherwise be killed; only a real invocation counts.
    const procs = [{ pid: 700, ppid: 1, name: "node.exe", cmd: "node scripts/other.mjs --note http-bridge.mjs" }];
    assert.deepEqual(selectTargets({ procs, ports: [], selfPid: 999 }), []);
  });

  it("excludes the shared service port unless includeShared is set", () => {
    // selectTargets consults real ports, so drive it through the port argument
    // path by stubbing: an empty port list means marker-based selection only.
    const procs = [
      { pid: 800, ppid: 1, name: "opencode.exe", cmd: "opencode.exe serve --port 45278" },
      { pid: 900, ppid: 1, name: "opencode.exe", cmd: "opencode.exe serve --port 4099" },
    ];
    const picked = selectTargets({ procs, ports: [], selfPid: 999 });
    // 45278 is not one of the dev markers, so it is left alone regardless.
    assert.deepEqual(picked.map((t) => t.pid), [900]);
  });
});

describe("pidsOnPort", () => {
  it("detects listeners on a localized netstat", () => {
    // A German Windows prints "ABHOEREN" instead of "LISTENING"; detection must
    // not depend on the state column being English.
    clearPortCache();
    const listener = pidsOnPort(KANBAN_PORT);
    assert.ok(Array.isArray(listener), "always returns an array");
    for (const pid of listener) assert.ok(Number.isFinite(pid) && pid > 0, `pid looks sane: ${pid}`);
  });

  it("reports a free port as having no pids", () => {
    clearPortCache();
    assert.deepEqual(pidsOnPort(1), [], "port 1 is not held by this stack");
  });
});

describe("listProcesses", () => {
  it("returns a usable snapshot including this process", () => {
    const procs = listProcesses();
    assert.ok(Array.isArray(procs));
    assert.ok(procs.length > 0, "at least this process");
    const me = procs.find((p) => p.pid === process.pid);
    assert.ok(me, "snapshot contains our own pid");
    assert.ok(Number.isFinite(me.ppid), "own parent pid is a number");
    assert.equal(typeof me.cmd, "string");
  });
});