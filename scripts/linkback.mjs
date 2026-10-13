// Pure logic for the result link-back (Option B delivery ledger).
//
// Kept out of vite.config.js so it can be unit tested: vite.config.js imports
// these and does only the I/O (CLI scan + OpenCode prompt POST).
//
// The loop is data-driven, not caller-driven: kanban.py `task notify-pending`
// finds finished tasks with a parent and notified_at IS NULL, and
// `task notify-mark` stamps them only after the queue POST succeeds.

/** Max tasks quoted in one batched message to a parent. */
export const LINKBACK_CAP_PER_PARENT = 5;
/** Result text quoted per task in the message body. */
export const LINKBACK_RESULT_CHARS = 2000;
/** Blocker context quoted per blocked task in the message body. */
export const LINKBACK_CONTEXT_CHARS = 400;

/** Kill switch: KANBAN_RESULT_LINKBACK=0 (or off/false/no) disables delivery. */
export function linkbackEnabled(envValue) {
  const v = String(envValue ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** Parent session id, from camelCase or snake_case rows. Empty string if absent. */
export function parentKeyOf(t) {
  const p = t?.parentSessionId ?? t?.parent_session_id;
  return typeof p === "string" ? p.trim() : "";
}

/** The task's own session id, so a self-parented task is never delivered. */
export function selfIdOf(t) {
  const s = t?.sessionId ?? t?.session_id;
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Split pending rows into deliverable groups and ids that must be stamped
 * without delivery.
 *
 * @returns {{ byParent: Map<string, array>, selfIds: string[] }}
 *   byParent: parentSessionId -> rows to quote in one message (caller caps).
 *   selfIds: task ids that can never be delivered (self-parent or no parent),
 *            so the caller stamps them and the scan stops retrying them.
 */
export function groupPending(rows) {
  const byParent = new Map();
  const selfIds = [];
  for (const t of Array.isArray(rows) ? rows : []) {
    const parent = parentKeyOf(t);
    if (!parent) {
      if (t?.id) selfIds.push(t.id);
      continue;
    }
    if (parent === selfIdOf(t)) {
      if (t?.id) selfIds.push(t.id);
      continue;
    }
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(t);
  }
  return { byParent, selfIds };
}

/**
 * One queued message for a parent. Style follows ASD-STE100: short sentences,
 * one instruction per sentence.
 */
export function buildLinkbackPrompt(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const lines = list.map((t) => {
    const title = String(t.title || "(untitled)").slice(0, 200);
    const status = String(t.status || "?").toUpperCase();
    const result = String(t.result ?? t.result_text ?? "").trim().slice(0, LINKBACK_RESULT_CHARS);
    const ctx = String(t.resultContext ?? t.result_context ?? "").trim().slice(0, LINKBACK_CONTEXT_CHARS);
    let line = `- "${title}" (${String(t.id || "").slice(0, 8)}…) is now ${status}.`;
    if (result) line += ` Result: ${result}`;
    if (ctx && status === "BLOCKED") line += ` Context: ${ctx}`;
    return line;
  });
  const n = list.length;
  return (
    `[Board] finished task${n === 1 ? "" : "s"} reporting back:\n` +
    lines.join("\n") +
    `\n\nTell the user what finished and what it means. Start no new work unless asked.`
  );
}

/**
 * Groups -> per-parent deliverables. Each parent gets at most
 * LINKBACK_CAP_PER_PARENT quoted tasks; rows beyond the cap stay unstamped and
 * are delivered on the next pass.
 *
 * @returns {Map<string, { parent: string, text: string, ids: string[] }>}
 */
export function planDeliveries(byParent, cap = LINKBACK_CAP_PER_PARENT) {
  const plan = new Map();
  for (const [parent, list] of byParent) {
    const chunk = list.slice(0, Math.max(0, cap));
    if (chunk.length === 0) continue;
    plan.set(parent, {
      parent,
      text: buildLinkbackPrompt(chunk),
      ids: chunk.map((t) => t.id).filter(Boolean),
    });
  }
  return plan;
}
