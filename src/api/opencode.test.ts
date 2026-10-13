import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionInstruction, putSessionInstruction } from './opencode.ts';

type Captured = { url: string; init: RequestInit };

// node --test runs each file in its own process, but restoring the real
// fetch in `finally` keeps the assertions below from masking later calls.
const realFetch = globalThis.fetch;

function stubFetch(response: Response | (() => Response)): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test('putSessionInstruction PUTs { value } to the experimental entries path', async () => {
  const calls = stubFetch(new Response(null, { status: 204 }));
  try {
    const res = await putSessionInstruction('ses_1', 'board-assistant', '# hello');
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/kanban/oc/experimental/session/ses_1/instructions/entries/board-assistant');
    assert.equal(calls[0].init.method, 'PUT');
    // Step 1 probe: the body key is `value`; `content`/`text` return 400.
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { value: '# hello' });
  } finally {
    restoreFetch();
  }
});

test('putSessionInstruction reports the status instead of throwing on 413', async () => {
  const calls = stubFetch(() => new Response('too large', { status: 413 }));
  try {
    const res = await putSessionInstruction('ses_1', 'board-assistant', 'x'.repeat(9000));
    assert.equal(res.ok, false);
    assert.equal(res.status, 413);
    assert.match(String(res.error), /413/);
  } finally {
    restoreFetch();
  }
});

test('putSessionInstruction returns ok:false when the network throws', async () => {
  const calls = stubFetch(() => { throw new Error('offline'); });
  try {
    const res = await putSessionInstruction('ses_1', 'board-assistant', 'x');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'Error: offline');
  } finally {
    restoreFetch();
  }
});

test('getSessionInstruction reads the entry list and picks our key', async () => {
  const calls = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          data: [
            { key: 'other', value: 'not ours' },
            { key: 'board-assistant', value: '# Board assistant — Demo' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );
  try {
    const value = await getSessionInstruction('ses_1', 'board-assistant');
    assert.equal(value, '# Board assistant — Demo');
    // The spec has no single-key GET, so this must hit the list path.
    assert.equal(calls[0].url, '/api/kanban/oc/experimental/session/ses_1/instructions/entries');
  } finally {
    restoreFetch();
  }
});

test('getSessionInstruction returns null when the key is absent', async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  try {
    assert.equal(await getSessionInstruction('ses_1', 'board-assistant'), null);
  } finally {
    restoreFetch();
  }
});

test('getSessionInstruction returns null on a non-2xx list', async () => {
  stubFetch(() => new Response('nope', { status: 500 }));
  try {
    assert.equal(await getSessionInstruction('ses_1', 'board-assistant'), null);
  } finally {
    restoreFetch();
  }
});