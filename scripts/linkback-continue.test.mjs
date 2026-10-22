import test from "node:test"
import assert from "node:assert/strict"
import { buildLinkbackPrompt, linkbackClosing, planDeliveries } from "./linkback.mjs"

test("the delivery tells a user facing assistant to report and wait", () => {
  const text = buildLinkbackPrompt([{ id: "t1", title: "A", status: "done", result: "ok" }]);
  assert.match(text, /Start no new work unless asked\./);
  assert.match(text, /\[Board\] Delegated task update/);
});

test("the delivery tells an orchestrator to continue its plan", () => {
  const text = buildLinkbackPrompt(
    [{ id: "t1", title: "A", status: "done", result: "ok" }],
    { continueWork: true },
  );
  assert.match(text, /one step of your plan/);
  assert.match(text, /start the next step/);
  assert.doesNotMatch(text, /Start no new work unless asked/);
});

test("the closing line is short and concrete", () => {
  assert.match(linkbackClosing(false), /Report the task title/);
  assert.match(linkbackClosing(true), /continue your plan/);
  for (const sentence of linkbackClosing(true).split(". ")) {
    assert.ok(sentence.split(" ").length <= 20, `too long: ${sentence}`);
  }
});

test("only the parents with a plan get the continue text", () => {
  const byParent = new Map([
    ["ses_orch", [{ id: "t1", title: "A", status: "done", result: "ok" }]],
    ["ses_chat", [{ id: "t2", title: "B", status: "done", result: "ok" }]],
  ]);
  const plan = planDeliveries(byParent, 5, { continueParents: new Set(["ses_orch"]) });
  assert.match(plan.get("ses_orch").text, /one step of your plan/);
  assert.match(plan.get("ses_chat").text, /Start no new work unless asked/);
});
