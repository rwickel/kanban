import test from "node:test"
import assert from "node:assert/strict"
import { completionStatus } from "./task-completion.mjs"

test("only an explicit complete marker marks a successful session done", () => {
  assert.deepEqual(completionStatus({ succeeded: true, kind: "oneshot", finalAssistantText: "Verified. KANBAN_TASK_COMPLETE" }), { status: "done", reason: "explicitly complete" })
  assert.deepEqual(completionStatus({ succeeded: true, kind: "oneshot", finalAssistantText: "Partial work; KANBAN_TASK_INCOMPLETE" }), { status: "blocked", reason: "agent reported incomplete work" })
  assert.deepEqual(completionStatus({ succeeded: true, kind: "oneshot", finalAssistantText: "Looks good." }), { status: "blocked", reason: "completion was not verified" })
})

test("failed and cyclic outcomes retain their lifecycle behavior", () => {
  assert.deepEqual(completionStatus({ failed: true, succeeded: false, kind: "oneshot" }), { status: "blocked", reason: "session failed" })
  assert.deepEqual(completionStatus({ succeeded: true, kind: "cyclic", finalAssistantText: "KANBAN_TASK_COMPLETE" }), { status: "backlog", reason: "explicitly complete" })
  assert.equal(completionStatus({ succeeded: false, kind: "oneshot" }), null)
})

test("the completion marker wins over a session that fails afterwards", () => {
  // The agent finished and said so. The session broke while it cleaned up.
  // The work is done, so the task is done.
  assert.deepEqual(
    completionStatus({ failed: true, succeeded: false, kind: "oneshot", finalAssistantText: "Merged. KANBAN_TASK_COMPLETE" }),
    { status: "done", reason: "explicitly complete" },
  )
  // Without the marker a failed session stays blocked.
  assert.deepEqual(
    completionStatus({ failed: true, succeeded: false, kind: "oneshot", finalAssistantText: "The merge failed." }),
    { status: "blocked", reason: "session failed" },
  )
  // An explicit incomplete marker also wins over the failure.
  assert.deepEqual(
    completionStatus({ failed: true, succeeded: false, kind: "oneshot", finalAssistantText: "Not done. KANBAN_TASK_INCOMPLETE" }),
    { status: "blocked", reason: "agent reported incomplete work" },
  )
})
