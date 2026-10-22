import test from "node:test"
import assert from "node:assert/strict"
import { completionStatus } from "./task-completion.mjs"

test("a session that ended normally is done", () => {
  assert.deepEqual(completionStatus({ succeeded: true, kind: "oneshot" }), { status: "done", reason: "the session ended" })
  assert.deepEqual(completionStatus({ succeeded: true, kind: "oneshot", finalAssistantText: "Looks good." }), { status: "done", reason: "the session ended" })
})

test("a failed session is blocked and an open session changes nothing", () => {
  assert.deepEqual(completionStatus({ failed: true, succeeded: false, kind: "oneshot" }), { status: "blocked", reason: "session failed" })
  assert.equal(completionStatus({ succeeded: false, kind: "oneshot" }), null)
})

test("a cyclic task goes back to the backlog", () => {
  assert.deepEqual(completionStatus({ succeeded: true, kind: "cyclic" }), { status: "backlog", reason: "the session ended" })
})

test("a goal task waits", () => {
  assert.deepEqual(completionStatus({ succeeded: true, kind: "goal" }), { status: "running", reason: "goal task waits" })
  assert.deepEqual(completionStatus({ failed: true, succeeded: false, kind: "goal" }), { status: "blocked", reason: "session failed" })
})
