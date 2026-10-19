import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

import { BRIDGE_PORT, KANBAN_PORT, createBridge } from "./http-bridge.mjs";

const servers = [];
after(() => {
  for (const s of servers) s.close();
});

/** Starts a server on an ephemeral port and resolves to that port. */
function listen(server, port = 0) {
  servers.push(server);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
}

/** Minimal stand-in for the board: answers the probe path and echoes the body. */
function fakeBoard() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url, method: req.method, body: Buffer.concat(chunks).toString() }));
    });
  });
  return server;
}

function get(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("http bridge", () => {
  it("forwards GET to a plain-HTTP upstream and keeps the path and status", async () => {
    const boardPort = await listen(fakeBoard());
    const bridgePort = await listen(createBridge({ targetPort: boardPort }));
    const res = await get(bridgePort, "/api/kanban/tasks?status=done");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.ok, true);
    assert.equal(body.url, "/api/kanban/tasks?status=done");
  });

  it("forwards POST bodies intact", async () => {
    const boardPort = await listen(fakeBoard());
    const bridgePort = await listen(createBridge({ targetPort: boardPort }));
    const res = await get(bridgePort, "/api/kanban/delegate", {
      method: "POST",
      body: JSON.stringify({ projectId: "p1", title: "three words" }),
    });
    const body = JSON.parse(res.text);
    assert.equal(body.method, "POST");
    assert.deepEqual(JSON.parse(body.body), { projectId: "p1", title: "three words" });
  });

  it("answers 502 as JSON when the upstream is unreachable, not a socket crash", async () => {
    const deadPort = await listen(fakeBoard());
    await new Promise((resolve) => servers.pop().close(resolve));
    const bridgePort = await listen(createBridge({ targetPort: deadPort }));
    const res = await get(bridgePort, "/api/kanban/tasks");
    assert.equal(res.status, 502);
    assert.match(JSON.parse(res.text).error, /kanban bridge:/);
  });

  it("uses the documented bridge port so the dev script and agents agree", () => {
    assert.equal(BRIDGE_PORT, 3002);
    assert.equal(KANBAN_PORT, 3001);
  });
});

void https; // upstream https support is exercised by dev:https, not by unit tests