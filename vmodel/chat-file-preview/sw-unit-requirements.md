# Software Unit Requirements

## SW-UR-FILEPATHS-01

- Purpose: Classify any href as file or external before render.
- Interface: `classifyHref(href: string | undefined, root: string): 'file' | 'external'`.
- Data contract: `file-preview:` prefix and absolute paths under the root
  (case-insensitive on Windows) return `file`; all other values return
  `external`.
- Requirement: REQ-CHAT-FILE-01, REQ-CHAT-FILE-03.
- Test: `filePaths.test.ts` classification cases.

## SW-UR-FILEPATHS-02

- Purpose: Linkify extensionless absolute paths under the root.
- Interface: `linkifyFilePaths(markdown: string, root: string): string`.
- Data contract: Bare Windows and Unix absolute paths without a file
  extension are wrapped as `file-preview:` links only when they resolve
  under the root. Existing `[text](url)` links are left untouched.
- Requirement: REQ-CHAT-FILE-02.
- Test: `filePaths.test.ts` extensionless path cases.

## SW-UR-FILEPATHS-03

- Purpose: Show the filename, never the full address, for internal links.
- Interface: `basenameOf(path: string): string` and the label written by
  `linkifyFilePaths`.
- Data contract: The markdown label is the last path segment. The full path
  stays in the encoded `file-preview:` href and the button `title`.
- Requirement: REQ-CHAT-FILE-06.
- Test: `filePaths.test.ts` filename label cases.

## SW-UR-CHATFEED-01

- Purpose: Route classified hrefs to the modal or a new tab.
- Interface: the `a` renderer in `ThinkingBlock` and `ChatBubble`.
- Data contract: `classifyHref` result `file` renders the `onFileClick`
  button; `external` renders `externalLink`. No `file-preview:` check
  remains in the renderer.
- Requirement: REQ-CHAT-FILE-04.
- Test: build passes; manual click check in the chat panel.

## SW-UR-VITE-ROOT-01

- Purpose: Expose the projects root to the client.
- Interface: `GET /api/kanban/file/root` in `vite.config.js`.
- Data contract: Returns `{ root }` as a JSON object; `root` equals the
  resolved `KANBAN_PROJECTS_ROOT` value.
- Requirement: REQ-CHAT-FILE-05.
- Test: `curl` against the dev server.
