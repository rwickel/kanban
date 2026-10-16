# Concept and Design

## Problem

The chat renders messages in server JSON array order. `toChatMessages` flattens and dedupes the raw list while preserving arrival order, and `useSessionStream.merge` rebuilds the feed from that output ("order follows the server list").

The server array order is not guaranteed to match chronology. Concrete symptom: a provider-error row (assistant message with `error` and no content parts) renders as the **last** chat message only because it is the **last element in the JSON**. Its `time` field may place it earlier than messages shown above it, so the error appears in the wrong chronological position — and any later message would push it up while it still belongs where its timestamp says.

The messages already carry timestamps (`time.created` / `time.start`, also under `info`; already read for elapsed-time extraction), but nothing orders by them.

## Design

1. **Extract a timestamp per raw message.** Add `messageTimestamp(raw): number | undefined` in `chatEvents`. Probe in order: `time.created`, `time.start`/`time.started`, top-level `timestamp`/`created`/`createdAt`, then the same fields under `info`. Normalize seconds-vs-ms with the existing heuristic (`< 1e11 → × 1000`). For error rows derived from an assistant failure, `time.completed`/`time.end` is an acceptable fallback (the moment the call failed).

2. **Carry the stamp on the normalized row.** Extend `ChatMessage` with `createdAtMs?: number`. Every row derived from one raw message (user text, reasoning, tool rows, execute wrapper + inner subcalls, file, provider-error row, compaction/idle error rows) inherits the same `createdAtMs`, so rows that belong to one message stay grouped through the sort.

3. **Stable sort at the list boundary only.** `toChatMessages` dedupes as today, then performs one **stable** ascending sort by `createdAtMs`. Rows without a timestamp sort after all stamped rows but keep their relative server order (treat missing as `+Infinity`; stability preserves the sequence). Ties on the same millisecond keep server order. Within one raw message the content-part order (reasoning → tools → text) is meaningful and is preserved via the inherited equal timestamp + stable sort.

4. **Merge stays order-following — no change needed.** `useSessionStream.merge` rebuilds from `toChatMessages(incoming)`, which is now chronological, so the feed becomes chronological automatically. Same-id replacements (tool pending → completed) keep a stable `createdAtMs`, so no flicker. Local-only ids the server dropped are still appended at the end (they have no server stamp).

5. **Decouple status detection from array position.** The live/closed idle detection compares `lastIdleIndex > lastChatIndex` by array index. Once rows can sit at a different position than their raw index, this must compare **timestamps** (idle-marker time vs last chat-message time, both from the raw list) instead of indices, so an idle marker that is mid-array chronologically no longer flips the status wrongly.

## Edge cases

- Same-ms ties → stable server order, no arbitrary reshuffle.
- Messages missing `time` → fall to the end in server order; never interleaved wrongly among stamped rows.
- Seconds-vs-ms ambiguity → reuse the proven `toMs` heuristic.
- A retried provider error keeps its own (earlier) time and lands at its chronological position instead of being pinned to the bottom.
- Sort is deterministic for equal input (stable), so repeated polls produce identical order.

## Non-goals

- Rendering timestamps in the UI (this is ordering only; `meta` display is unchanged).
- Reordering content parts inside one raw message beyond what stable sort gives.
- Changing the error-row parsing itself (`provider-error-chat` already covers it).

## Modules

- `chatEvents`: extract and attach `createdAtMs`; stable chronological sort in `toChatMessages`.
- `useSessionStream`: consume the sorted output; switch idle/live detection from array indices to timestamps.
- `ChatFeed`: no changes — renders the list order it is given.
- `chatToMarkdown`: inherits chronological order from its input.

## Dependencies

`ChatFeed` and `chatToMarkdown` depend on the `ChatMessage` ordering produced by `chatEvents.toChatMessages`; `useSessionStream.merge` inherits that order. Timestamp extraction reuses the seconds-vs-ms normalization already proven in `extractMeta`/`toMs`.
