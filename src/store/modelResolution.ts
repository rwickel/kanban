// Single source of truth for "which model runs this session".
// Order: task pick → browser-wide pref (when the project allows it) →
//        first entry of the project's allowed pool → OpenCode server default.
//
// A project does NOT carry a default model — it carries a POOL of models that
// may be used inside it (see Project.allowedModels). An empty pool means "no
// restriction", so an untouched project behaves exactly like before.
// Pure functions only — no I/O, fully unit-testable (see modelResolution.test.ts).

import type { TaskModelPref } from './serverConfig';

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Pair guard: a model is only valid when BOTH halves are non-empty.
 *  (OpenCode's Model.Ref 400s on a half-filled pair — mirror that client-side.) */
export function pairModel(
  providerID?: string | null,
  modelID?: string | null
): ModelRef | null {
  const p = (providerID ?? '').trim();
  const m = (modelID ?? '').trim();
  return p && m ? { providerID: p, modelID: m } : null;
}

/** "providerID/modelID" string → ModelRef. Splits on the FIRST slash only —
 *  model ids can contain slashes (e.g. "anthropic/claude"). */
export function parseModelString(value?: string | null): ModelRef | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const idx = v.indexOf('/');
  if (idx <= 0 || idx === v.length - 1) return null;
  return { providerID: v.slice(0, idx), modelID: v.slice(idx + 1) };
}

/** Format a ModelRef for display/select values: "providerID/modelID". */
export function formatModelRef(ref?: ModelRef | null): string {
  return ref ? `${ref.providerID}/${ref.modelID}` : '';
}

/** Anything carrying optional model halves — server rows use null, UI props undefined. */
export interface ModelSource {
  modelId?: string | null;
  modelProviderID?: string | null;
}

/** The project's contribution to model choice: a pool, never a default. */
export interface ProjectModelPolicy {
  /** "providerID/modelID" entries usable in this project. Empty/absent = unrestricted. */
  allowedModels?: string[] | null;
}

/**
 * Canonicalise a stored pool: trim, drop malformed entries (anything that is not
 * a valid "providerID/modelID"), de-duplicate, keep the user's selection order.
 */
export function normalizeAllowedModels(list?: string[] | null): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const v = (raw ?? '').trim();
    if (!v || !parseModelString(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * May `model` ("providerID/modelID") be used in a project with this pool?
 * No pool at all = no restriction. A pool that exists but holds no usable entry
 * fails CLOSED (nothing selectable) — a broken list must never widen access.
 */
export function isModelAllowed(model?: string | null, allowedModels?: string[] | null): boolean {
  if (!hasRestriction(allowedModels)) return true;
  const pool = normalizeAllowedModels(allowedModels);
  const v = (model ?? '').trim();
  return !!v && pool.includes(v);
}

/** Did the project actually opt into a restriction? (Raw array, before cleaning.) */
function hasRestriction(allowedModels?: string[] | null): boolean {
  return Array.isArray(allowedModels) && allowedModels.length > 0;
}

/**
 * Resolve the model for a session about to be created.
 *
 *   1. task-level pick      — explicit per-task choice, never rewritten
 *   2. browser-wide pref    — localStorage default, kept only if the project allows it
 *   3. project pool         — first allowed model (the pool is a constraint, not a default)
 *   4. null                 — omit from the request → OpenCode server default
 *
 * An explicit task pick outside the pool still wins: silently swapping it would
 * hide the mismatch. The pickers filter by the pool so this only happens for
 * models chosen before the project was restricted.
 */
export function resolveSessionModel(
  task?: ModelSource | null,
  project?: ProjectModelPolicy | null,
  pref?: TaskModelPref | null
): ModelRef | null {
  const taskRef = pairModel(task?.modelProviderID, task?.modelId);
  if (taskRef) return taskRef;

  if (!hasRestriction(project?.allowedModels)) return pairModel(pref?.providerID, pref?.modelID);

  const prefRef = pairModel(pref?.providerID, pref?.modelID);
  const pool = normalizeAllowedModels(project?.allowedModels);
  if (prefRef && pool.includes(formatModelRef(prefRef))) return prefRef;
  // Fail closed: a pool that yields nothing usable falls through to the OpenCode
  // default instead of silently re-opening every model.
  return pool.length ? parseModelString(pool[0]) : null;
}
