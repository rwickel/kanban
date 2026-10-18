export function completionStatus({ succeeded, failed, kind, finalAssistantText = "" }) {
  if (failed) return { status: "blocked", reason: "session failed" }
  if (!succeeded) return null
  const complete = /(?:^|\s)KANBAN_TASK_COMPLETE(?:\s|$)/.test(finalAssistantText)
  const incomplete = /(?:^|\s)KANBAN_TASK_INCOMPLETE(?:\s|$)/.test(finalAssistantText)
  if (complete && !incomplete) return { status: kind === "cyclic" ? "backlog" : "done", reason: "explicitly complete" }
  return {
    status: "blocked",
    reason: incomplete ? "agent reported incomplete work" : "completion was not verified",
  }
}
