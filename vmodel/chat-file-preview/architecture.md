# Architecture

Classification is a pure function in `filePaths.ts`. React components read
the classification and pick a renderer. No path string reaches the DOM as an
`href` when it names a file under the root.

The browser never holds an OpenCode password. File reads go through the vite
middleware (`/api/kanban/file`). OpenCode v2 fs endpoints are reachable via
the existing `/api/kanban/oc/*` proxy and are optional fallbacks only.

The root value flows one way: server `.env` → `GET /api/kanban/file/root` →
client cache → `classifyHref`. No component reads `KANBAN_PROJECTS_ROOT`
from a module constant.
