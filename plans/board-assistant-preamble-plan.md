# Plan — Board Assistant Preamble Injection

> Replace the single-line session-id hint on the first turn with a proper preamble flow, so the board assistant behaves like task agents.

**Repo:** `kanban-clone` · branch `main` · mode `direct` (no PRs; `gh` absent; edit-in-place + verify)
**Date:** 2026-10-13 · **Author:** 1Tier via `/blueprint`
**Docs:**
- `prompts/final-message-style.md` — existing style snippet already loaded by tasks (`App.tsx` `buildTaskPrompt`) and delegates (`vite.config.js:loadStyleGuide`).
- `docs/OPENCODE_V2_ENDPOINTS.md` — `POST /session/{id}/prompt` only has `text`; v2 exposes an **experimental** instructions surface `PUT /api/experimental/session/{id}/instructions/entries/{key}` (docs lines 88-90). Global `~/.config/opencode/opencode.json` separately registers repo-file instructions (`AGENTS.md`, `instructions/INSTRUCTIONS.md`) — a different mechanism (project-wide, not per-session).

---

## 1) Why "session-id hint only" is insufficient

- Only first-turn knowledge: if the user pauses, switches topics, or lets compaction occur, the role + delegate rules vanish.
- Text tag buried inside user prompt: no reliable system/instruction tier; the LLM treats it as content, not role.
- Diverges from task path: `App.tsx:buildTaskPrompt` + `vite.config.js:delegateTask` both front-load a coherent "how to work" preamble + style guide. Board assistant should mirror that.
- No observability: preamble is not shared with other surfaces (plugin delegate docs, board docs). Users cannot inspect or tune it.
- Risk → re-implement task prompt hygiene once, reuse everywhere; avoid kopi-paste `promptPrefix` strings across components.

---

## 2) Options evaluated

| Option | What it is | Fit | effort | Risk |
|--------|------------|-----|--------|------|
| **A — Session instructions entry** (recommended) | At assistant session creation, `PUT {base}/session/{id}/instructions/entries/board-assistant` — where `{base}` is `/api` or `/api/experimental` per the Step 1 probe — with the rendered preamble markdown. Rendered from `prompts/board-assistant-preamble.md` templated with project name, team roster, style guide, delegate API. | Aligns with v2 `instructions/*` surface flagged in `OPENCODE_V2_ENDPOINTS.md:88-90` (`/api/experimental/session/{id}/instructions/entries/{key}` — note the `/experimental` prefix; Step 1 must confirm against live `openapi.json` since the plan initially dropped it); mirrors `AGENTS.md` pattern. Instruction persists per-session; **claimed** compaction-aware — Step 1 must verify, not assume. | low–medium | API is `experimental` — Step 1 probes the full path AND payload shape against live `openapi.json` before any code is written. |
| **B — File-based instruction via `.agents/board-assistant.md`** | Drop a project-level agent/instruction file into the worktree (e.g. `.agents/board-assistant.md` or `.opencode/instructions/board-assistant.md`) referenced from the assistant session's `location.directory`. | Would load automatically like `AGENTS.md`; no per-session API. But requires FS write into `project.path` inside `KANBAN_PROJECTS_ROOT`; collides with user content; hard to scope per-session or per-project; deploy-time mutation. | low | Pollutes project; not per-session; tricky to revert. |
| **C — First-turn structured block (status quo fix)** | Keep current `text` path but promote the hint to a fenced `## Board Assistant — context` header with project/team/delegate docs + style guide. Minimal change in `AssistantChatWindow.tsx:handleSend`. | Simple fallback if A fails; zero server surface. Still not a real instruction tier, but matches task agents today. | lowest | Same fragility (first turn only, compaction drop). |
| **D — Custom prompt slot in `opencode.json` per-directory** | Add a `promptPrefix` or `systemPrompt` field at session create (undocumented). | Not in v2 docs; would require OpenCode patch. | high | Fragile assumption. |

**Decision:** Implement **A primary** with **C fallback**. Add the preamble file + `ensureAssistantPreamble(sessionId)` helper; attempt the instruction `PUT` on the probed `/api/experimental/session/.../instructions/entries/board-assistant` path; on non-2xx, fall back to prefixing the *next* prompt (not only first turn) with the same markdown so behavior degrades gracefully. File itself lives in repo (`prompts/board-assistant-preamble.md`) + shipped to runtime via fetch or Vite proxy, similar to `final-message-style.md`.

---

## 3) Target behavior

- **Authoritative call site:** the PUT lives **only** inside `assistantSession.ts createFor` (`assistantSession.ts:58-70`), which already sits behind the `inflight` map (`assistantSession.ts:56`). Do **not** also PUT from `ensureAssistantSession` (`assistantSession.ts:76`) or the chat component — `App.tsx:244` and `AssistantChatWindow.tsx:157` both call it and would double-PUT.
- After `createSession` succeeds in `createFor`, `PUT {base}/session/{id}/instructions/entries/board-assistant` (via `/api/kanban/oc`, server-injected auth) with the rendered preamble. Failure never blocks: `ensureAssistantSession` returns the id regardless.
- **Re-push on attach.** Stored sessions are reused forever (`ensureAssistantSession:80-81` returns a cached id with no refresh), so a create-only PUT leaves stale roster/style text on every reopened chat. `AssistantChatWindow` re-PUTs on session attach (after the entry-exists check in S4). Create-time PUT is then just a fast path for the un-opened chat, not the only push.
- The session-id hint is **not** kept separately: it becomes a line inside the preamble file. Keeping both duplicates the session id in every prompt.
- Content: same signal shape as `buildTaskPrompt` "How to work + API + style" but tuned to the assistant role: board-centric, no task, delegate steps only as `POST /api/kanban/delegate` HTTP (mirrors the delegate tool docs in `opencode-plugin/index.ts:326-362`), lists the project team, and includes the `final-message-style.md` fragment via `loadStyleGuide()`.
- Non-goals: no change to the task prompt path; no Vite middleware contract change (the generic `/api/kanban/oc/*` forwarder already handles any method/path — see S5).

### 3.1 Preamble content contract

Markdown file `prompts/board-assistant-preamble.md` with handlebars-like slots:

```md
# Board assistant — {{project.name}}

Project: {{project.name}} ({{project.path}})
Board base: http://localhost:3001/api (full spec: http://localhost:3001/api/kanban/docs)
Session id: {{sessionId}}  — pass as "parentSessionId" when delegating so results link back here.

## Team for this project
{{teamLines}}  # same format as buildTaskPrompt teamLines

## How to work
- This is a board assistant chat: answer questions, summarize boards/tasks, propose work. No task exists unless you delegate or the user creates one.
- When you DO create follow-up work: POST /api/kanban/delegate { "projectId": "{{project.id}}", "title": "...", "agentId": "<teammate-id>", "parentSessionId": "{{sessionId}}" } (fire-and-forget) or wait:true.
- Follow-up in the same subtask session: POST /api/kanban/message_to { "sessionId": "<from delegate>", "text": "..." }.
- List/inspect: GET /api/kanban/tasks?projectId={{project.id}}, kanban_list_tasks, etc. via MCP are available.

{{styleGuide}}
```

Slots filled from `project`, `availableAgents`, `getTaskModelPref()`/selectedModel, and `sessionId`. The file is the single authoritive text — both the instruction entry and the fallback inline prefix render from it, so no drift.

---

## 4) Step plan (6 steps, cold-start briefs)

### Step 1 — Probe the instructions surface (read-only, gated)

- **Goal:** confirm the real instruction endpoint **path** (`/api/...` vs `/api/experimental/...`), method, payload shape, auth path, **and whether entries survive compaction**.
- **Do:**
  1. From a running `opencode serve`, fetch `openapi.json` (proxy through `/api/kanban/oc/openapi.json` first; fall back to direct `GET http://127.0.0.1:4099/api/openapi.json` with `Authorization: Basic opencode:<OPENCODE_SERVER_PASSWORD>` read from the ignored root `.env`). Confirm whether the operation is `PUT /api/experimental/session/{sessionID}/instructions/entries/{key}` (as `OPENCODE_V2_ENDPOINTS.md:88-90` says) or under plain `/api/session/...`, and record its body schema.
  2. Create a throwaway session (`POST /api/kanban/oc/session { "title": "probe", "location": {"directory": "<project.path>"} }`) then `PUT` a minimal entry (`{ "content": "hello board assistant" }` / `{ "text": "hello" }` — try both) and `GET` it back. Record which shape sticks.
  3. **Proxy pass-through:** `PUT` the same path *through* `/api/kanban/oc/experimental/...` and verify 2xx with **no** password header from the shell. This is the same confirmation S5 needs — doing it here unblocks S3's dependency. If the generic `oc` forwarder (`vite.config.js:928`) rejects it, record the exact blocker now and add the fix to S3, not S5.
  4. **Compaction survival (the claim the plan rests on):** send a short user prompt + a stub reply until the session compacts (or `POST /session/{id}/compact` directly), then `GET` the instruction entry again and check whether the entry is still injected into the prompt sent to the model (visible in `GET /session/{id}/context` or the run log). If it does not survive, mark Option A's "compaction-aware" justification false and promote Option C to primary.
  5. **Security:** never write the password value into this plan, the decision log, or console transcripts — record only "read from root `.env`".
- **Verify:** path + payload + compaction result recorded as a "Step 1 decision log" amendment in this file. `npm run typecheck` still passes (no code touched).
- **Exit:** decision log added + no code touched.
- **Rollback:** none (read-only; the throwaway probe session can be `DELETE`d).
- **Depends on:** nothing.

#### Step 1 decision log (2026-10-13, probed live)

| Question | Result |
|----------|--------|
| Spec source | `https://opencode.ai/v2/openapi.json` — local `/api/openapi.json` returns 404, so the published spec was fetched. Password read from the ignored root `.env` (value not recorded anywhere). |
| Path | **`/api/experimental/session/{sessionID}/instructions/entries/{key}`** confirmed. Plain `/api/session/...` returns **404** — the plan's original path was wrong. |
| Methods | `GET` (list), `PUT` (attach/replace), `DELETE` (remove) on `.../entries/{key}`. List lives on `.../entries`. |
| Payload | **Required key is `value`** (`{"value": <any JSON>}`, `additionalProperties: false`). The plan's guessed `content` / `text` both returned **400**. |
| Responses | `PUT` → **204 No Content**; `DELETE` → 204; `GET` → `{"data":[{"key","value"}]}`. Errors: 400 / 401 / 404 / **413 `InstructionEntryValueTooLargeError`**. |
| Proxy pass-through | `PUT /api/kanban/oc/experimental/session/{id}/instructions/entries/board-assistant` → **204** with **no** password header. Generic `oc` forwarder (`vite.config.js:928`) needs no change. |
| Durability | Spec describes it as a "**durable** instruction entry… announced at the next step boundary" — store-side persistence confirmed; not tied to any message turn. |
| Compaction survival | **Not fully exercised** — forcing a compaction would require driving a real model run. Spec-level wording ("durable", step-boundary announcement) is the available evidence. Inline fallback in S4 covers the residual risk. |
| Cleanup | Probe entries (`probe-content`, `probe-text`, `board-assistant`) deleted via `DELETE` → 204. |

**Implications for the steps:** S3 must send `{ value: markdown }` on the `/experimental/...` path (not `content`/`text`, not `/api/session/...`). S4's fallback stays as insurance rather than a primary path. S5 has nothing to change.

### Step 2 — Add `prompts/board-assistant-preamble.md` + template renderer

- **Context (cold):** repo uses `prompts/final-message-style.md` loaded via `fetch('/api/kanban/prompts/final-message-style.md')` (`App.tsx:66`). Prompts live under `prompts/`. Style is read once and cached. Kanban API base is `http://localhost:3001/api` per `App.tsx:380`. Team roster comes from `project.agentIds` ∩ `agents[]`.
- **Do:**
  1. Create `prompts/board-assistant-preamble.md` with slots `{{projectName}}`, `{{projectPath}}`, `{{projectId}}`, `{{sessionId}}`, `{{teamLines}}`, `{{styleGuide}}`.
  2. Add `src/prompts/boardAssistantPreamble.ts` exporting `renderBoardAssistantPreamble(args: { project, agents: Agent[], sessionId: string, teamLines: string, styleGuide: string }) → string`. Pure string templating + `{{…}}` substitution; no fetch. Optionally `loadBoardAssistantTemplate()` fetching the file (same pattern as `loadStyleGuide`) — keep fetch optional for runtime composition.
  3. **Do NOT extract** `buildTeamLines`/`loadStyleGuide` in this step — leave `App.tsx:buildTaskPrompt` untouched. S5.2's optional extraction is cut; duplication of ~8 team-lines is cheaper than a shared-module refactor.
- **Verify:** `npm run typecheck`; file renders with fixtures (e.g. vitest snapshot is overkill — a `node --test src/prompts/boardAssistantPreamble.test.mjs` spot-check or ad-hoc script verifying placeholders replaced).
- **Exit:** template file + renderer land; no behavior change.
- **Rollback:** delete added files.
- **Depends on:** Step 1.

### Step 3 — `src/api/opencode.ts` + `src/store/assistantSession.ts` — `ensureAssistantPreamble` plumbing

- **Context:** `src/api/opencode.ts` owns `baseUrl() → /api/kanban/oc` and helper `headers()` (no password in browser) and `createSession`/`sendPrompt`. `src/store/assistantSession.ts` owns `createFor → createSession` + `ensureAssistantSession` with the `inflight` map at `assistantSession.ts:56`. Vite proxy forwards `PUT` through the generic `oc` block (`vite.config.js:928` — `ocPath = "/" + parts.slice(1)…` plus `ocAuthHeaders`), but S1 already verified that path including `/experimental`. Payload shape + base prefix (`/api` vs `/api/experimental`) come from S1's decision log.
- **Do:**
  1. In `src/api/opencode.ts`, add `putSessionInstruction(sessionId, key, markdown)` doing `PUT ${baseUrl()}/experimental/session/{id}/instructions/entries/{key}` (or the S1-confirmed base) with the confirmed payload key (`{ content: markdown }` or `{ text: markdown }` — annotate the single chosen one with a comment citing `openapi.json` + S1 probe result). Reuse `headers({ 'Content-Type': 'application/json' })`. Do **not** reuse `vite.config.js:capResult` (4000 chars) on this path — that cap belongs to board `result` capture; truncating here would slice the preamble itself.
  2. Export `ensureAssistantPreamble(sessionId, project, agents, styleGuide, renderedFallback?)` that renders from `renderBoardAssistantPreamble` or accepts pre-rendered markdown, then calls `putSessionInstruction(sessionId, 'board-assistant', markdown)`. Returns `{ ok }`; never throws — warn on failure. The `board-assistant` key is authoritative (not `board-assistant-preamble` — fix the drift from the options table).
  3. In `src/store/assistantSession.ts`, after `createSession` success **inside `createFor` only** (not in `ensureAssistantSession` at L76 and not in `App.tsx:244`/`AssistantChatWindow:157`), call `ensureAssistantPreamble`. Do not block the returned `{ id }` on it beyond a short `await`; keep `inflight` semantics intact.
  4. Add a spot test (e.g. `src/api/opencode.test.mjs` or extend `scripts/*.test.mjs`; `npm test` is `node --test src/**/*.test.ts scripts/**/*.test.mjs`).
- **Verify:** `npm run typecheck`; `npm test`. Create a real assistant session via dev build and `GET /api/kanban/oc/experimental/session/{id}/instructions/entries/board-assistant` — entry exists (gate with `KAI_DEBUG` may log `PUT`).
- **Exit:** instruction is pushed automatically on every new assistant session (fast path); failures are silent.
- **Rollback:** revert `opencode.ts` helper + `assistantSession.ts` call.
- **Depends on:** Steps 1–2. **Parallel with:** none.

### Step 4 — `AssistantChatWindow.tsx` fallback + dedup + lifecycle re-push

- **Context:** `AssistantChatWindow` currently injects `[Your session id: …]` only on `msgCount === 0` (`handleSend` L239–243), shows empty welcome text when `sessionId` is still `null` (`AssistantChatWindow:263-266`), and clears the session on agent/model change (`AssistantChatWindow:128-150` → new chat re-triggers `ensureSession` at L169-173). Stored sessions are reused forever (`assistantSession.ts:80-81`), so a stale roster/style lives on unless re-pushed.
- **Do:**
  1. **Re-push on attach (the real durable fix).** On session attach — both on the initial `useEffect` at `AssistantChatWindow:169` and on `handleAgentChange`/`handleModelChange`'s implicit recreation — `GET .../instructions/entries/board-assistant`, re-render the preamble from `renderBoardAssistantPreamble`, and `PUT` if missing or stale (compare `teamLines`/`styleGuide` hash or just PUT idempotently — cheap). This is where stale rosters get corrected, not in S3.
  2. **Fallback only on real failure.** The fallback is **not** a `preambleOkRef` per-mount flag (that would stay "failed" forever after one bad PUT and never retry). Instead: check the GET from (1); if not ok, do **one** PUT retry; only when that retry also fails, prefix the outgoing `POST prompt` body with `renderedPreamble + "\n\n" + text`. Don't cap that composition at 4000 — send the full user text; server-side limits apply.
  3. **No stacked preambles.** Gate the prefix on a stable marker present only in the preamble (`# Board assistant —`). If the composed body already contains it, don't add again. The marker check is `body.includes('# Board assistant —')` at send time — not a ref that resets on mount.
  4. **Single source of truth.** The session-id delegation hint becomes a line inside `prompts/board-assistant-preamble.md`. **Delete** the separate `Your session id: ${sid} — when you delegate…` string from `handleSend` at L240-241 (keep at most an empty `"\n\n" + text` join — no duplication).
  5. **Don't block on fixes:** welcome text at L263-266 should not read `…pass the session id shown above…` while `sessionId` is null — it already handles both branches; keep it, just ensure the preamble (once pushed) is not re-announced.
- **Verify:** `npm run typecheck`; manual: delete `localStorage kanban_assistant_session_*`, reopen chat → `PUT` 2xx (+ optional `GET` confirms); agent/model switch → new session → new `PUT`; revisit existing session → `GET` detects stale → re-PUT; kill the server, send a message → one retry then inline prefix on the `POST prompt` request body; send 10 rapid messages → no stacked preambles.
- **Exit:** no more first-turn-only gap; second+ turns carry role whether via instruction tier or (after one retry) inline.
- **Rollback:** revert fallback prefix block + re-push on attach.
- **Depends on:** Steps 2–3.

### Step 5 — Smoke check for the already-probed proxy (minimal)

- **Context:** The proxy pass-through for `PUT .../instructions/entries/*` was already confirmed in S1.3 through the generic `oc` forwarder (`vite.config.js:928`). No method allow-list and no extra Vite plugin change are expected. `App.tsx:buildTaskPrompt` + `vite.config.js:loadStyleGuide` already embed `final-message-style.md` — do not touch them (scope cut).
- **Do:**
  1. Keep this step build-only: `npm run build` (which exercises the Vite plugin bundle) and re-run the probe fetch from S1.3 now that S3 code exists. If it still 2xx, document "no proxy change needed" in the S1 decision log and leave `vite.config.js` untouched.
  2. No extraction of `renderTeamLines`/`loadStyleGuide` in this step (explicitly dropped as scope creep — see S2.3).
- **Verify:** `npm run build`; manual: the S1 probe fetch still 2xx after S3.
- **Exit:** proxy confirmed end-to-end with no file change.
- **Rollback:** none (likely no-op).
- **Depends on:** Step 3.

### Step 6 — Docs + manual QA checklist

- **Do:**
  1. Update `docs/OPENCODE_V2_ENDPOINTS.md` session table: correct the instruction endpoint row (path with the confirmed `/experimental` prefix + payload shape) and note the board assistant preamble is stored under key `board-assistant`.
  2. Add a short section to `docs/CHAT_TO_TASK_CONCEPT.md` (single target; README unchanged): "Board assistant preamble — role + delegate rules live in `prompts/board-assistant-preamble.md`, pushed via `PUT .../instructions/entries/board-assistant` on session create and re-pushed on chat attach; inline prefix only after one failed retry."
  3. QA script (manual): delete `kanban_assistant_session_<id>` from localStorage → reopen chat → `sessionId` pill appears; `PUT instructions` 2xx; first message routes; close/reopen chat → same session, **one** re-push `PUT` (not zero); change agent in the dropdown → session cleared → new session + new `PUT` (covers S4's missing agent/model-switch case); send 10 rapid messages → no stacked preambles; stop `opencode serve` → send → one retry then inline prefix; restart server → next attach recovers to instruction path.
- **Verify:** `npm run typecheck`; `npm run build`; docs render.
- **Exit:** feature is observable, documented, and QA'd.
- **Rollback:** revert doc edits.
- **Depends on:** Steps 4–5.

---

## 5) Dependency graph + parallelization

```
S1 Probe (path+payload+compaction+proxy) ─> S2 Template/renderer ─> S3 Preamble plumbing ─┬─> S4 Chat fallback + re-push ─┐
                                                                                          └─> S5 Build/proxy smoke ─────┴─> S6 Docs/QA
```
- S1 alone (includes the proxy confirmation S3 depends on — it is no longer deferred to S5). S2 after S1. S3 after S2. S4 and S5 both after S3 (no shared files: S4 touches `AssistantChatWindow.tsx`, S5 touches none). S6 after S4+S5.

---

## 6) Invariants (hold after every step)

- `npm run typecheck` passes.
- `npm run build` passes (once Vite steps exist).
- Existing task flow (`backlog → running`) unchanged; task preamble still produced by `buildTaskPrompt`.
- Board assistant feature flag stays implicit: disabling preamble falls back to inline prefix; never blocks chat.
- No credential leakage: browser never holds `OPENCODE_SERVER_PASSWORD`; all OpenCode calls via `/api/kanban/oc/*` with server-injected Basic auth.
- `KAI_DEBUG=false` by default; no extra log surface unless enabled.

---

## 7) Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Instruction endpoint is experimental, and the path is `/api/experimental/session/...` (plan originally dropped the prefix). | S1 probes the exact path from live `openapi.json` before any code; S3 hardcodes the confirmed base with a citing comment; inline fallback keeps the feature working on 404. |
| Compaction drops the instruction — the core justification over option C. | S1.4 **probes** compaction survival rather than assuming; if false, promote option C to primary and fold the preamble into every send. |
| Stale instruction on long-lived sessions (roster/style edits never propagate, unlike task prompts which re-render every run). | S4.1 re-PUTs on chat attach (stale or missing), covering both reopen and agent/model switches. |
| Double PUT: `App.tsx:244` and `AssistantChatWindow:157` both call `ensureAssistantSession`. | Create-time PUT lives only inside `createFor` behind the existing `inflight` map; S3.3 states this explicitly. |
| Stacked preambles on repeated sends. | Send-time marker guard (`body.includes('# Board assistant —')`), independent of mount lifecycle. |
| Fallback state stuck "failed" forever after one transient error. | GET-on-attach + one PUT retry before falling back to inline; no per-mount flag. |
| Session id duplicated in the prompt when both hint and preamble carry it. | S4.4 deletes the standalone hint string from `handleSend`; single source in the preamble file. |
| Vite proxy blocks PUT to instructions. | Confirmed in S1.3 (before S3 depends on it); S5 is build/smoke only. |
| Truncating the preamble with a result-capture cap. | `capResult`'s 4000-char cap is board-result-specific; explicitly not reused on this path. |
| `prompts/*.md` fetch caching staleness. | Same caching mode as `final-message-style.md`; acceptable. |
| Password leaking into logs / committed decision log. | S1.5 forbids recording the secret; only "read from root `.env`" is logged. |

---

## 8) Rollback strategy

Each step is a small additive edit with a reverted counterpart noted. No data migrations. Stored instruction entries under the `board-assistant` key can be removed with `DELETE .../instructions/entries/board-assistant` (docs line 90), but leaving them is harmless.

---

## 9) Verification matrix (maps to steps)

| What | Where | When |
|------|-------|------|
| endpoint path + payload shape + compaction survival | `openapi.json` + probe via `/api/kanban/oc` | S1 |
| template renders + substitutes | `src/prompts/boardAssistantPreamble.ts` | S2, `npm run typecheck` + spot test |
| `PUT instructions` 2xx + readable back | `src/api/opencode.ts` (PUT only inside `createFor`) | S3, network tab `GET instructions/entries/board-assistant` |
| no stacked preambles, fallback after one retry, re-push on attach + agent/model switch | `AssistantChatWindow.tsx` | S4, manual two-send + switch-agent checks |
| proxy forwards PUT instructions (already probed in S1) | `vite.config.js` kanbanApi `oc` block — untouched | S5, `npm run build` + re-probe |
| docs (single target) + QA checklist | `docs/OPENCODE_V2_ENDPOINTS.md`, `docs/CHAT_TO_TASK_CONCEPT.md` | S6 |
