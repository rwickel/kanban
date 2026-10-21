export function completionStatus({ succeeded, failed, kind, finalAssistantText = "" }) {
  // The marker is the agent's own statement that the work is done. It wins over
  // a session failure that happens AFTER the final message: a session can
  // break while it cleans up, and that must not undo finished work.
  const complete = /(?:^|\s)KANBAN_TASK_COMPLETE(?:\s|$)/.test(finalAssistantText)
  const incomplete = /(?:^|\s)KANBAN_TASK_INCOMPLETE(?:\s|$)/.test(finalAssistantText)
  if (complete && !incomplete) {
    return { status: kind === "cyclic" ? "backlog" : "done", reason: "explicitly complete" }
  }
  if (incomplete) return { status: "blocked", reason: "agent reported incomplete work" }
  if (failed) return { status: "blocked", reason: "session failed" }
  if (!succeeded) return null
  return {
    status: "blocked",
    reason: "completion was not verified",
  }
}
