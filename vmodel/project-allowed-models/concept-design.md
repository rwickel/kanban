# Concept and Design — Project Allowed Models

> Supersedes `vmodel/project-model-selection/`. That design gave a `Project` a
> **single default model**; this one replaces it with a **pool of models that may
> be used**. The earlier concept stays for history — its data model, resolution
> level 2 and two-dropdown picker no longer exist.

## Problem

The project's model setting was two cramped native `<select>`s: a provider list
built from a `p:${providerID}` value hack, and a model list that stayed *disabled*
until a provider was picked — and that silently wiped the model whenever the
provider changed. No search, no model display names, no grouping. The provider
list itself was hard to scan, and worse, the setting only expressed a *default*,
so a project could not say "these models, and only these, belong here".

## Goals

1. Project settings offer the **list of available providers**, each expandable to
   its models, with search and per-provider select-all — on desktop *and* mobile,
   from one shared component.
2. The user selects **the models that may be used in the project** (a pool, not a
   single value). An empty pool = no restriction.
3. One documented resolution order, implemented once, reused by task execution,
   task creation, and the assistant.
4. A stored pool is never silently lost: a failed fetch or a vanished model keeps
   the entry visible and removable rather than dropping it.

## Non-Goals

- No API-key / credential management — OpenCode owns providers
  (`GET /api/kanban/oc/model` is read-only here).
- No cost/rate limits, no per-agent overrides, no hard blocking of a task model
  chosen *before* the project was restricted (see "Enforcement" below).

## Model Source

`GET /api/kanban/oc/model` → `Model.Info[]` via `fetchModels()`
(`src/api/opencode.ts`), which dedupes `providerID/modelID` and sorts.

## Data Model

`Project` (`src/types.ts`):

```ts
export interface Project {
  // …existing fields…
  /** "providerID/modelID" entries usable here. Empty/absent = no restriction. */
  allowedModels?: string[] | null;
}
```

Storage — `server/kanban.py`:

- `projects.allowed_models TEXT` holding a JSON array of `"providerID/modelID"`.
- Backfilled in `get_conn()` next to `agent_ids` / `folder` / `git_url`, so old
  DBs keep opening.
- `project_allowed_models(row)` reads the column, and — while it is still `NULL`
  — **seeds the pool from the legacy `model_id` + `model_provider_id` pair** so a
  project's earlier choice survives the migration. Writing the column (including
  `'[]'`) makes the legacy columns dead for good.
- CLI: `project create|update --allowed-model <ref>` (repeatable) and
  `--clear-allowed-models`. Scalar-per-flag rather than one JSON blob so no shell
  can mangle it while quoting (PowerShell strips embedded double quotes).
- `project update` with only a pool change must not hit the "Nothing to update."
  branch.

Proxy — `vite.config.js`: `b.allowedModels` → `--allowed-model` per entry (or
`--clear-allowed-models` when empty) on both `POST /api/kanban/projects` and
`PATCH /api/kanban/projects/:id`. Arrays already travel as separate argv elements
via `execFile` (`--agent-id`), so nothing is ever re-quoted.

API docs — `docs/KANBAN_API.md`: `allowedModels[]` on the project payload and on
create/update.

## Resolution Order (single source of truth)

`resolveSessionModel(task, project, pref)` in `src/store/modelResolution.ts`:

```
1. task.modelProviderID + task.modelId     — explicit per-task pick, never rewritten
2. pref (getTaskModelPref)                 — only if the project allows it
3. project.allowedModels[0]                — the pool is a constraint, not a default
4. null                                    — omitted → OpenCode server default
```

Pure helpers, all unit-tested (`modelResolution.test.ts`):

| Helper | Meaning |
|---|---|
| `normalizeAllowedModels(list)` | trim, drop malformed entries, de-dupe, keep the user's order |
| `isModelAllowed(model, pool)` | may this model be used here? no pool → yes |
| `resolveSessionModel(...)` | the four-level order above |

**Fail closed.** A pool that *exists* but yields no usable entry returns `null`
(OpenCode default) — a corrupted list must never widen back to "every model".

### Enforcement

- **Defaults** (session create, assistant pref, new-task initial pick) are
  resolved through the order above, so they always land on an allowed model.
- **Pickers** filter by the pool: `TaskModal`, `MobileTaskForm`,
  `AssistantChatWindow`, `MobileChat`, `SessionChatWindow`.
- **A stored task model outside the pool still wins.** Silently swapping it would
  hide the mismatch; the pickers mark it `(not allowed in this project)` so it
  stays visible and changeable. Only tasks *created after* the project was
  restricted normally see an allowed model.

## UI

`src/components/ModelPoolPicker.tsx` — one component, used by `ProjectModal`
(desktop) and `MobileMenu` (mobile):

- Header `Models — usable in this project` + refresh (re-runs `fetchModels()`).
- Search box filtering providers *and* models by provider id, model id, name.
- Provider rows: tri-state checkbox (select/deselect every model it shows),
  `selected/total` count, expand/collapse chevron. Expanded by default while a
  search is active.
- Model rows: checkbox + `modelID — name` in mono.
- Entries selected earlier but absent from the current list get their own
  `Selected but not in the current list` group — a failed fetch can never
  silently drop them.
- Footer: `No restriction — every provider model is available.` when empty, else
  `N models allowed`, plus `Select all` / `Clear`.

## Error Handling & Edge Cases

- **Model list unavailable**: warning row + refresh; selection untouched.
- **Stale model**: kept visible under its own group, removable, never auto-dropped.
- **Malformed entry**: rejected server-side (`expected "providerID/modelID"`);
  if one ever lands in the column it is filtered out client-side and the pool
  fails closed rather than open.
- **Offline**: project edits are not in the offline queue (only tasks are) — same
  as other project fields.
- **Legacy rows**: `allowed_models IS NULL` + legacy pair → seeded pool; both
  absent → unrestricted.

## Testing done for this change

- Unit: `src/store/modelResolution.test.ts` — 15 cases covering precedence,
  normalization, `isModelAllowed`, and fail-closed behaviour of a malformed pool.
- Server round-trip (CLI): create with a pool, replace it, unrelated update
  preserves it, clear it, malformed entry rejected (exit 1), both flags rejected,
  legacy row seeds from `model_id`/`model_provider_id`, clearing the legacy row
  sticks.
- `tsc --noEmit`: no new errors (the 7 remaining ones predate this change).

## Open Questions

- Should a task whose stored model falls outside the pool be *blocked* from
  starting instead of merely warned about? v1 keeps explicit-wins so existing
  tasks are never broken by tightening a project.
- Should the assistant chat show *why* a remembered model was discarded (it now
  silently falls back to an allowed one)?
