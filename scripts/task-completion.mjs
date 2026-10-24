// The status of a task after its session ended.
//
// There is no completion marker. The session outcome decides:
//   - the session failed        -> blocked
//   - the session ended normally -> done (a cyclic task goes back to backlog)
//   - a goal task                -> running (it waits for the user or children)
//
// An agent that cannot finish sets the status itself with
// kanban_update_status(blocked). The board keeps that decision.
export function completionStatus({ succeeded, failed, kind }) {
  if (failed) return { status: "blocked", reason: "session failed" }
  if (!succeeded) return null
  // A goal task waits: for the user, for the answer to a question, or for
  // its children. It is not done and it is not stuck.
  if (kind === "goal") return { status: "running", reason: "goal task waits" }
  if (kind === "cyclic") return { status: "backlog", reason: "the session ended" }
  return { status: "done", reason: "the session ended" }
}

// Preserve an explicit block and reject completion when the worktree is not verified.
export function reconciledCompletionStatus({ currentStatus, statusBy, worktreeState, checksPassed = true, ...completion }) {
  if (currentStatus === "blocked" && statusBy && statusBy !== "reconciler") return null
  if (worktreeState === "conflict" || worktreeState === "unverified" || checksPassed === false)
    return { status: "blocked", reason: "worktree or checks are not verified" }
  return completionStatus(completion)
}
