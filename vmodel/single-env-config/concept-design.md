# Concept and Design

## Problem

OpenCode credentials exist in `.env`, `.kanban-data/opencode.json`, and the global MCP configuration. These copies can become inconsistent.

## Design

Use the ignored root `.env` as the only OpenCode server configuration source.

## Modules

- `scripts/env.mjs`: Parse and load the root `.env` for Node processes.
- `scripts/dev.mjs`: Start Vite and OpenCode with the same environment.
- `vite.config.js`: Read OpenCode URL and password only from process environment.
- `opencode-plugin/`: Read the root `.env` before reading OpenCode settings.
- `ServerConfigModal`: Show and test environment-managed settings without accepting secrets.
