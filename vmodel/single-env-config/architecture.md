# Architecture

The root `.env` is the single credential boundary. It remains excluded from Git.

`npm run dev` loads `.env` once and passes its environment to both child services. The independently launched Kanban MCP process loads the same file directly.

The browser receives only the server URL and a boolean that reports whether a password exists. The password never enters browser state.
