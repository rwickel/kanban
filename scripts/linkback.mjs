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

/** Extract a readable blocker from plain text or a JSON error envelope. */
export function blockerText(task) {
  const raw = String(
    task?.resultContext ?? task?.result_context ?? task?.startupError ?? task?.startup_error ?? task?.progress ?? "",
  ).trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error ?? parsed?.message ?? parsed?.task?.startupError;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Plain text is already suitable for the parent message.
  }
  return raw;
}

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
 * Worktree lines of a finished task: branch, state, folder, merge note.
 * The state tells the parent if the work reached the project branch.
 */
export function worktreeLines(task) {
  const branch = String(task?.worktreeBranch ?? task?.worktree_branch ?? "").trim();
  if (!branch) return [];
  const state = String(task?.worktreeState ?? task?.worktree_state ?? "").trim() || "unknown";
  const path = String(task?.worktreePath ?? task?.worktree_path ?? "").trim();
  const note = String(task?.worktreeNote ?? task?.worktree_note ?? "").trim();
  const lines = [
    `- **Worktree branch:** \`${branch}\``,
    `- **Worktree state:** ${state}`,
  ];
  if (path) lines.push(`- **Worktree folder:** \`${path}\``);
  if (note) lines.push(`- **Merge note:** ${note}`);
  if (state === "conflict") {
    lines.push("- The branch was **not merged** because of a conflict. Resolve it with `kanban_worktree` (action `merge`) or report it.");
  }
  return lines;
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
    const taskId = String(t.id || "(missing)");
    const sessionId = String(t.sessionId ?? t.session_id ?? "(missing)");
    const result = String(t.result ?? t.result_text ?? "").trim().slice(0, LINKBACK_RESULT_CHARS);
    const ctx = blockerText(t).slice(0, LINKBACK_CONTEXT_CHARS);
    const detail = [
      `## ${title}`,
      ``,
      `- **Status:** ${status}`,
      `- **Task ID:** \`${taskId}\``,
      `- **Session ID:** \`${sessionId}\``,
    ];
    if (result) detail.push(`- **Result:** ${result}`);
    if (ctx && status === "BLOCKED") detail.push(`- **Blocker:** ${ctx}`);
    detail.push(...worktreeLines(t));
    return detail.join("\n");
  });
  return (
    `[Board] Delegated task update\n\n` +
    lines.join("\n\n---\n\n") +
    `\n\nReport the task title, status, task ID, session ID, result, blocker, and worktree merge state. Start no new work unless asked.`
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
