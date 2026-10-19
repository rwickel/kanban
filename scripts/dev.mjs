import { spawn } from 'node:child_process';
import net from 'node:net';

import { loadEnvFile } from './env.mjs';
import { BRIDGE_PORT, startBridge } from './http-bridge.mjs';

loadEnvFile();

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

const services = [
  {
    name: 'kanban',
    command: 'vite',
    port: 3001,
    env: process.argv.includes('--https') ? { KANBAN_HTTPS: '1' } : {},
  },
  { name: 'opencode', command: 'opencode serve --port 4099', port: 4099, env: {} },
];

// `dev:https` puts the board behind a self-signed cert, which Node `fetch` and
// PowerShell both reject. Mirror it on plain HTTP so agents can call the API
// with either runtime.
if (process.argv.includes('--https') && !portInUse(BRIDGE_PORT)) {
  startBridge();
  console.log(`[kanban] plain-HTTP API bridge on http://127.0.0.1:${BRIDGE_PORT} (use this from agents)`);
}

const children = [];
for (const service of services) {
  // Reuse a service already listening on its configured port. This makes
  // `npm run dev` safe after a previous terminal or OpenCode restart.
  if (await portInUse(service.port)) {
    console.log(`[${service.name}] already running on port ${service.port}; reusing it`);
    continue;
  }
  const child = spawn(service.command, { env: { ...process.env, ...service.env }, shell: true, stdio: 'inherit' });
  child.on('error', (error) => console.error(`[${service.name}] ${error.message}`));
  children.push({ name: service.name, child });
}

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) if (!child.killed) child.kill();
  process.exitCode = exitCode;
}

if (children.length === 0) {
  console.log('Kanban and OpenCode are already running.');
}

for (const { name, child } of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (signal) console.error(`[${name}] stopped by ${signal}`);
    else if (code) console.error(`[${name}] exited with code ${code}`);
    stop(code ?? 0);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
