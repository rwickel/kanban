# Project Instructions

## Tool Transparency (write/edit)
After every `write` or `edit` tool call, always show in chat by default:
- file path
- lines changed / created
- changes as `diff` code block — same style as OpenCode:
  ```diff
  + added line (green)
  - removed line (red)
  ```

For `edit`: show unified diff (removed red `-`, added green `+`).
For `write` (new file): show full content as `diff` with `+` prefix on each line.

Never rely on the tool's `Wrote file successfully` message alone — it hides content.
