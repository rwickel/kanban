# Project Instructions

## Change Summary (ASD-STE100)
After every `write` or `edit` tool call, show in chat by default:
- file path
- one sentence per change, Simplified Technical English (ASD-STE100):
  - Use approved, simple verbs: add, remove, update, move, rename, fix, replace.
  - One instruction per sentence. Maximum 20 words per sentence.
  - No `diff` blocks. No `+`/`-` line dumps. No code quotes unless the user asks.
  - Example: "Add message_to endpoint to vite.config.js."
