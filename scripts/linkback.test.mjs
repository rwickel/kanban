import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LINKBACK_CAP_PER_PARENT,
  linkbackEnabled,
  parentKeyOf,
  selfIdOf,
  groupPending,
  blockerText,
  buildLinkbackPrompt,
  planDeliveries,
} from "./linkback.mjs";

describe("linkbackEnabled", () => {
  it("is on by default and tolerates casing/whitespace", () => {
    assert.equal(linkbackEnabled(undefined), true);
    assert.equal(linkbackEnabled("1"), true);
    assert.equal(linkbackEnabled(" ON "), true);
  });
  it("is off for 0/false/off/no", () => {
    for (const v of ["0", "false", " FALSE ", "off", "no", "NO"]) {
      assert.equal(linkbackEnabled(v), false, `value: ${v}`);
    }
  });
});

describe("parentKeyOf / selfIdOf", () => {
  it("reads camelCase or snake_case rows and trims", () => {
    assert.equal(parentKeyOf({ parentSessionId: "  ses_a  " }), "ses_a");
    assert.equal(parentKeyOf({ parent_session_id: "ses_b" }), "ses_b");
    assert.equal(parentKeyOf({}), "");
    assert.equal(parentKeyOf(null), "");
    assert.equal(selfIdOf({ sessionId: " ses_c " }), "ses_c");
    assert.equal(selfIdOf({ session_id: "ses_d" }), "ses_d");
    assert.equal(selfIdOf({}), "");
  });
});

describe("groupPending", () => {
  const mk = (id, parent, self) => ({ id, parentSessionId: parent, sessionId: self });
  it("groups by parent and never mixes parents", () => {
    const { byParent, selfIds } = groupPending([
      mk("t1", "ses_p1", "ses_c1"),
      mk("t2", "ses_p1", "ses_c2"),
      mk("t3", "ses_p2", "ses_c3"),
    ]);
    assert.equal(selfIds.length, 0);
    assert.deepEqual([...byParent.keys()].sort(), ["ses_p1", "ses_p2"]);
    assert.deepEqual(byParent.get("ses_p1").map((t) => t.id), ["t1", "t2"]);
    assert.deepEqual(byParent.get("ses_p2").map((t) => t.id), ["t3"]);
  });
  it("routes self-parented tasks to selfIds so they are stamped, never delivered", () => {
    const { byParent, selfIds } = groupPending([
      mk("t1", "ses_same", "ses_same"),
      mk("t2", "ses_ok", "ses_c2"),
    ]);
    assert.deepEqual(selfIds, ["t1"]);
    assert.deepEqual([...byParent.keys()], ["ses_ok"]);
  });
  it("routes parentless rows to selfIds on every pass (scan stays clean)", () => {
    const { byParent, selfIds } = groupPending([
      { id: "t1" },
      { id: "t2", parentSessionId: "   " },
    ]);
    assert.equal(byParent.size, 0);
    assert.deepEqual(selfIds, ["t1", "t2"]);
  });
  it("tolerates non-array input", () => {
    assert.deepEqual(groupPending(null), { byParent: new Map(), selfIds: [] });
  });
});

describe("buildLinkbackPrompt", () => {
  it("quotes one task with status and result", () => {
    const text = buildLinkbackPrompt([
      { id: "abcdef123456", title: "Fix login", status: "done", result: "Token refresh fixed." },
    ]);
    assert.match(text, /\[Board\] Delegated task update/);
    assert.match(text, /## Fix login/);
    assert.match(text, /\*\*Status:\*\* DONE/);
    assert.match(text, /\*\*Task ID:\*\* `abcdef123456`/);
    assert.match(text, /\*\*Session ID:\*\* `\(missing\)`/);
    assert.match(text, /\*\*Result:\*\* Token refresh fixed\./);
    assert.match(text, /Report the task title, status, task ID, session ID/);
  });
  it("pluralises, quotes context on blocked, and skips context on done", () => {
    const text = buildLinkbackPrompt([
      { id: "t1", title: "Done one", status: "done", result: "r1", resultContext: "c1" },
      { id: "t2", title: "Stuck one", status: "blocked", result: "r2", resultContext: "hit the quota" },
    ]);
    const blockFor = (title) => text.split("---").find((block) => block.includes(`## ${title}`));
    assert.match(text, /Delegated task update/);
    assert.ok(blockFor("Done one"), "done block present");
    assert.doesNotMatch(blockFor("Done one"), /Blocker:/);
    assert.match(blockFor("Stuck one"), /\*\*Status:\*\* BLOCKED[\s\S]*\*\*Result:\*\* r2[\s\S]*\*\*Blocker:\*\* hit the quota/);
  });
  it("caps result and context length, tolerates missing fields", () => {
    const text = buildLinkbackPrompt([
      { id: "t9", title: "", status: "", result: "x".repeat(3000), resultContext: "y".repeat(600) },
    ]);
    assert.match(text, /## \(untitled\)/);
    assert.match(text, /\*\*Status:\*\* \?/);
    assert.match(text, /\*\*Task ID:\*\* `t9`/);
    assert.ok(text.includes("x".repeat(2000)), "result capped at 2000 chars");
    assert.ok(!text.includes("x".repeat(2001)), "result not longer than cap");
    assert.doesNotMatch(text, /Blocker:/);
  });
  it("handles an empty list", () => {
    assert.match(buildLinkbackPrompt([]), /Delegated task update/);
  });
  it("uses startupError when a blocked task has no result context", () => {
    const text = buildLinkbackPrompt([{
      id: "t10",
      title: "Timed out",
      status: "blocked",
      startupError: JSON.stringify({ error: "delegate timed out after 600s - still running" }),
    }]);
    assert.match(text, /\*\*Blocker:\*\* delegate timed out after 600s - still running/);
  });
  it("quotes the worktree branch, state and folder of a finished task", () => {
    const text = buildLinkbackPrompt([{
      id: "t11",
      title: "Isolated work",
      status: "done",
      result: "ok",
      worktreeBranch: "kanban/task-1a2b3c4d",
      worktreeState: "merged",
      worktreePath: "C:/work/.kanban-worktrees/proj/t11",
      worktreeNote: "Merged kanban/task-1a2b3c4d into main",
    }]);
    assert.match(text, /\*\*Worktree branch:\*\* `kanban\/task-1a2b3c4d`/);
    assert.match(text, /\*\*Worktree state:\*\* merged/);
    assert.match(text, /\*\*Worktree folder:\*\* `C:\/work\/\.kanban-worktrees\/proj\/t11`/);
    assert.match(text, /\*\*Merge note:\*\* Merged kanban\/task-1a2b3c4d into main/);
    assert.match(text, /worktree merge state/);
  });
  it("marks a conflicting worktree as not merged", () => {
    const text = buildLinkbackPrompt([{
      id: "t12",
      title: "Conflicting work",
      status: "done",
      worktreeBranch: "kanban/task-9f8e7d6c",
      worktreeState: "conflict",
      worktreeNote: "Automatic merge failed",
    }]);
    assert.match(text, /\*\*Worktree state:\*\* conflict/);
    assert.match(text, /was \*\*not merged\*\*/);
    assert.match(text, /kanban_worktree/);
  });
  it("omits worktree lines when the task has no worktree", () => {
    const text = buildLinkbackPrompt([{ id: "t13", title: "Plain", status: "done" }]);
    assert.doesNotMatch(text, /Worktree/);
  });
});

describe("blockerText", () => {
  it("prefers result context and extracts JSON error messages", () => {
    assert.equal(blockerText({ resultContext: "approval required", startupError: "ignored" }), "approval required");
    assert.equal(blockerText({ startupError: '{"error":"connection failed"}' }), "connection failed");
  });
});

describe("planDeliveries", () => {
  it("caps quoted tasks per parent and exposes ids for stamping", () => {
    const list = Array.from({ length: LINKBACK_CAP_PER_PARENT + 3 }, (_, i) => ({
      id: `task-${i.toString().padStart(2, "0")}-xxxxxxxx`,
      title: `T${i}`,
      status: "done",
      result: "ok",
    }));
    const plan = planDeliveries(new Map([["ses_p", list]]));
    const d = plan.get("ses_p");
    assert.equal(d.ids.length, LINKBACK_CAP_PER_PARENT);
    assert.match(d.text, /## T0/);
    assert.doesNotMatch(d.text, /## T5|## T6|## T7/);
  });
  it("keeps parents independent", () => {
    const plan = planDeliveries(new Map([
      ["ses_a", [{ id: "a1", title: "A", status: "done" }]],
      ["ses_b", [{ id: "b1", title: "B", status: "blocked", result: "stuck" }]],
    ]));
    assert.equal(plan.size, 2);
    assert.match(plan.get("ses_b").text, /\*\*Status:\*\* BLOCKED[\s\S]*\*\*Result:\*\* stuck/);
  });
});
