# Concept and Design: Chat File Preview

Chat and task-result messages reference files under `KANBAN_PROJECTS_ROOT`.
Clicking such a reference must open a modal that shows the file content inside
the app. External links must open in a new browser tab and never replace the
app window.

## Current state (facts from the code)

- `src/components/filePaths.ts` — `linkifyFilePaths` turns bare Windows and
  Unix paths in plain chat text into `[path](file-preview:<encoded>)` links.
  It only matches paths that carry a file extension. Existing `[text](url)`
  links pass through untouched so external links keep their `href`.
- `src/components/ChatFeed.tsx` — the `a` renderers in `ThinkingBlock` and
  `ChatBubble` intercept `file-preview:` hrefs and render a button that calls
  `onFileClick(absPath)`. External hrefs render via
  `src/components/markdownLink.tsx` (`externalLink`) with `target="_blank"
  rel="noreferrer noopener"`.
- `src/components/FilePreviewModal.tsx` — modal with Content and Diff tabs.
  Content fetches `GET /api/kanban/file?path=`; Diff fetches
  `GET /api/kanban/file/diff?path=`.
- `vite.config.js` — both routes confine the path to
  `KANBAN_PROJECTS_ROOT`, reject directory reads, cap size at 512 KB,
  truncate content at 20 000 chars, and run `git diff HEAD -- <file>` for the
  Diff tab.
- `AssistantChatWindow`, `SessionChatWindow`, and `MobileChat` already wire
  `onFileClick` to a `FilePreviewModal` instance.

## Gap

1. A path inside a markdown link — `[label](C:\Users\rober\work\kanban\x.txt)`
   or `[label](/relative/path.txt)` — is treated as an external link and opens
   in a new tab instead of the modal.
2. `parsePreviewHref` only understands the `file-preview:` scheme.
3. Paths without an extension are not linkified, so a bare `C:\...\kanban\utf8`
   in plain text stays inert.
4. The read backend is the vite middleware only. OpenCode v2 filesystem
   endpoints exist and are reachable but unused by the client.

## Design

### 1. Classify every href before rendering

Add `classifyHref(href, root): 'file' | 'external'` to `filePaths.ts`.

- `file-preview:` prefix → `file` (decode, resolve against root).
- Absolute Windows or Unix path → `file` if it starts with the resolved
  `KANBAN_PROJECTS_ROOT` (case-insensitive on Windows), else `external`.
- Everything else → `external`.

The root comes from the existing `/api/kanban/file` probe or a new
`GET /api/kanban/file/root` endpoint that returns `{ root }`. The client
fetches it once at startup and caches the value.

### 2. Extend linkification to extensionless paths

`linkifyFilePaths` gains an `EXTLESS_PATH_RE` for Windows and Unix absolute
paths without a dot in the final segment, matched only in plain text (the
existing `MD_LINK_RE` guard already skips `[text](url)` URLs). A path is
linkified only when it resolves under `KANBAN_PROJECTS_ROOT`, so random
words like `C:\Windows\win.ini` are unchanged.

### 3. Display rule: filename only, never the full address

Internal links never show the full path in the chat. The link label is the
basename (last segment of the path). The full path stays in the `href` and
the `title` attribute for tooltip and traceability.

- `linkifyFilePaths` renders `[basename](file-preview:<encoded full path>)`
  instead of `[full path](file-preview:<encoded full path>)`.
- The `a` renderer in `ChatFeed.tsx` passes the full path as `title`, so a
  hover shows the address without printing it into the text flow.
- Rule is enforced in `filePaths.ts` (pure function), so every chat
  surface inherits it: bubbles, thinking blocks, tool rows, task cards,
  export modal.

### 4. Route classified file hrefs to the modal

The `a` renderer in `ChatFeed.tsx` (both `ThinkingBlock` and `ChatBubble`)
calls `classifyHref`. A `file` result renders the existing `<button>` that
calls `onFileClick(absPath)`. An `external` result renders
`externalLink(href, children)`. No new DOM element, no new state.

### 5. OpenCode v2 as secondary read backend

Verified live on this machine (port 4099, Basic auth, via the
`/api/kanban/oc/*` proxy that already injects the password):

- `GET /api/fs/read/<abs path>` → 200, `application/octet-stream`, raw file
  bytes. Works with `C:/Users/...` forward-slash paths.
- `GET /api/fs/list?directory=<dir>` → `{ location, data: [{path, type}] }`.
- `GET /api/fs/find?query=<name>&limit=<n>` → `{ location, data: [{path,
  type}] }`.

The primary read stays `GET /api/kanban/file?path=` because it already
handles root confinement, size caps, and truncation. OpenCode v2 is an
optional fallback for the modal when the middleware is unavailable, and it
enables a future file-picker in the chat composer (`fs/find` for type-ahead,
`fs/list` for directory browse). No OpenCode v2 call is required for the
modal in phase 1.

## Edge cases

- Uppercase root vs lowercase path: compare case-insensitively on Windows.
- Trailing punctuation in bare paths: the existing `TRAIL` regex strips
  `.,;:!?` etc. before linkification.
- Paths outside the root: render as external links; the browser shows its
  usual "not found" behavior. The modal is not opened.
- Markdown links whose href is a root-relative path (`/kanban/utf8`):
  resolved against the root before classification.
- Idempotency: `linkifyFilePaths` early-returns when the text already
  contains `file-preview:` (existing guard, kept).
- Empty `href` (`href=""`): render as a button with no action; do not let an
  empty anchor navigate.

## Non-goals

- No file editing from the modal (read-only + git diff, as today).
- No file browser panel in the board; type-ahead picker is a later phase.
- No binary preview (images, PDFs); the modal keeps text + diff tabs.
- No changes to `kanban-task:` and `kanban-session:` routing.

## Modules and dependencies

- `filePaths.ts` — pure functions, no React. Depends on `root` string.
- `ChatFeed.tsx` — consumes `classifyHref`; no new props.
- `FilePreviewModal.tsx` — unchanged in phase 1.
- `vite.config.js` — new `GET /api/kanban/file/root` (trivial JSON).
- `src/api/opencode.ts` — new `fsRead`, `fsList`, `fsFind` wrappers (phase 2
  only; the proxy already exists).

