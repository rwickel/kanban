// Plain-HTTP front door for the kanban dev server.
//
// `npm run dev:https` puts Vite behind a self-signed certificate. Node's
// `fetch` and PowerShell's `Invoke-RestMethod` both reject that certificate
// (and plain http:// against a TLS listener just drops the socket), so agents
// burn several turns rediscovering the workarounds. This bridge listens on
// plain HTTP and forwards to whichever transport port 3001 is actually
// speaking, so `fetch('http://localhost:3002/...')` always works.
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

export const KANBAN_PORT = 3001;
export const BRIDGE_PORT = 3002;

// Connection-scoped headers must not be copied across a proxy hop.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

// The upstream is the Vite dev server, so a self-signed certificate is the
// expected case rather than an error condition. `agent` must be a real Agent
// instance, and is meaningless (and rejected) on the plain-HTTP transport.
const TLS_AGENT = new https.Agent({ rejectUnauthorized: false });

function send(transport, port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { host: "127.0.0.1", port, method, path, headers };
    if (transport === https) options.agent = TLS_AGENT;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error("probe timeout")));
    req.on("error", reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

async function canSpeak(protocol, port) {
  try {
    const transport = protocol === "https" ? https : http;
    const res = await send(transport, port, "GET", "/api/kanban/docs?format=json", {}, null);
    return res.status < 500;
  } catch {
    return false;
  }
}

export function createBridge({ targetPort = KANBAN_PORT } = {}) {
  let resolved = null;
  let probing = null;

  // Remember which transport answered so we probe once, not per request.
  async function transport() {
    if (resolved) return resolved;
    if (!probing) {
      probing = (async () => {
        for (const candidate of ["https", "http"]) {
          if (await canSpeak(candidate, targetPort)) {
            resolved = candidate;
            return resolved;
          }
        }
        // Nothing answered yet (vite may still be booting). Default to the
        // transport `dev:https` selects; a later request re-probes on failure.
        resolved = "https";
        return resolved;
      })();
    }
    return probing;
  }

  // One attempt per transport. A Vite restart can flip the board between http
  // and https, so on failure drop the cached choice, re-probe, and retry once
  // rather than surfacing a 502 the caller cannot act on.
  async function forward(req, headers, body) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const scheme = await transport();
      try {
        return await send(scheme === "https" ? https : http, targetPort, req.method, req.url, headers, body);
      } catch (err) {
        lastError = err;
        resolved = null;
        probing = null;
      }
    }
    throw lastError;
  }

  const server = http.createServer(async (req, res) => {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    const headers = forwardedHeaders(req);
    if (body && body.length && headers["content-length"] === undefined) {
      headers["content-length"] = String(body.length);
    }
    try {
      const upstream = await forward(req, headers, body);
      res.writeHead(upstream.status, upstream.headers);
      res.end(upstream.body);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `kanban bridge: ${error.message}` }));
    }
  });

  // Carry WebSocket upgrades through so https-only features stay usable.
  server.on("upgrade", async (req, socket, head) => {
    const scheme = await transport();
    const upstream = (scheme === "https" ? https : http).request({
      host: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: TLS_AGENT,
    });
    upstream.on("upgrade", (upRes, upSocket, upHead) => {
      const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.on("error", () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  });

  return server;
}

export function startBridge({ targetPort = KANBAN_PORT, port = BRIDGE_PORT } = {}) {
  const server = createBridge({ targetPort });
  server.listen(port, "127.0.0.1");
  return server;
}

// Only meaningful in https mode; in plain mode port 3001 is already reachable.
// pathToFileURL (not string concatenation) so the check holds on Windows,
// where import.meta.url carries file:/// and argv[1] does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBridge();
  console.log(`[kanban] plain-HTTP bridge on http://127.0.0.1:${BRIDGE_PORT} -> :${KANBAN_PORT}`);
}