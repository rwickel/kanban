import test from "node:test";
import assert from "node:assert/strict";
import { interruptTaskSession } from "../opencode-plugin/core.js";

test("interruptTaskSession uses context session when available", async () => {
  let received;
  const ok = await interruptTaskSession({ session: { interrupt: async (input) => { received = input; } } }, "", {}, "ses-valid");
  assert.equal(ok, true);
  assert.deepEqual(received, { sessionID: "ses-valid" });
});

test("interruptTaskSession uses HTTP when session context is absent", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = { url, options };
    return { ok: true };
  };
  assert.equal(await interruptTaskSession(undefined, "http://opencode", {}, "ses-absent-context"), true);
  assert.equal(requested.url, "http://opencode/session/ses-absent-context/interrupt");
  assert.equal(requested.options.method, "POST");
});
