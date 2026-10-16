import assert from 'node:assert/strict';
import test from 'node:test';

import { messageTimestamp, toChatMessage, toChatMessages } from './chatEvents.ts';

test('messageTimestamp reads ms, seconds, and info-nested time', () => {
  assert.equal(messageTimestamp({ time: { created: 1790000000000 } }), 1790000000000);
  // unix seconds normalize to ms
  assert.equal(messageTimestamp({ time: { created: 1790000000 } }), 1790000000000);
  // ISO date strings parse
  assert.equal(
    messageTimestamp({ time: { created: '2026-01-01T00:00:00Z' } }),
    Date.parse('2026-01-01T00:00:00Z'),
  );
  // time nested under info
  assert.equal(messageTimestamp({ info: { time: { start: 1790000000000 } } }), 1790000000000);
  // completion times are a fallback for error rows with no start time
  assert.equal(messageTimestamp({ time: { completed: 1790000005000 } }), 1790000005000);
  assert.equal(messageTimestamp({ id: 'no_time' }), undefined);
});

test('orders the feed by timestamp, not JSON position (REQ-TIME-01)', () => {
  const list = [
    { id: 'msg_user', type: 'user', text: 'hello', time: { created: 1790000000000 } },
    { id: 'msg_reply', type: 'assistant', time: { created: 1790000003000 }, content: [{ type: 'text', text: 'hi' }] },
    // Provider error is LAST in the JSON but happened between the two messages.
    { id: 'msg_err', type: 'assistant', time: { created: 1790000002000 }, content: [], error: { message: 'boom', status: 500 } },
  ];
  const messages = toChatMessages(list);
  assert.deepEqual(messages.map((m) => m.id), ['msg_user', 'msg_err-error', 'msg_reply']);
  assert.equal(messages[1]?.kind, 'error');
  assert.equal(messages[1]?.createdAtMs, 1790000002000);
});

test('equal timestamps keep server order and unstamped rows sort last (REQ-TIME-02/03)', () => {
  const list = [
    { id: 'msg_a', type: 'user', text: 'a', time: { created: 1790000000000 } },
    { id: 'msg_b', type: 'user', text: 'b', time: { created: 1790000000000 } },
    { id: 'msg_unstamped', type: 'user', text: 'u' },
    { id: 'msg_unstamped2', type: 'user', text: 'u2' },
    { id: 'msg_c', type: 'user', text: 'c', time: { created: 1790000005000 } },
  ];
  const messages = toChatMessages(list);
  // a/b tie → server order; stamped c before the unstamped pair, which keeps server order at the end
  assert.deepEqual(messages.map((m) => m.id), ['msg_a', 'msg_b', 'msg_c', 'msg_unstamped', 'msg_unstamped2']);
});

test('all rows of one message share its timestamp through the sort (REQ-TIME-04)', () => {
  const list = [
    { id: 'msg_late', type: 'user', text: 'later question', time: { created: 1790000009000 } },
    {
      id: 'msg_tools',
      type: 'assistant',
      time: { created: 1790000001000 },
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool', name: 'execute', state: { status: 'completed', input: { code: 'return 1;' } }, metadata: { toolCalls: [{ tool: 'search', input: { q: 'x' } }] } },
      ],
    },
  ];
  const messages = toChatMessages(list);
  // The tool message sorts before the later user message; its rows stay grouped.
  assert.deepEqual(messages.map((m) => m.id), ['msg_tools', 'msg_tools-tool', 'msg_tools-tool-0', 'msg_late']);
  for (const m of messages.slice(0, 3)) assert.equal(m.createdAtMs, 1790000001000);
  assert.equal(messages[3]?.createdAtMs, 1790000009000);
});

test('renders a provider error from an assistant message with empty content', () => {
  const messages = toChatMessage({
    id: 'msg_provider_error',
    type: 'assistant',
    content: [],
    finish: 'error',
    error: {
      type: 'provider.auth',
      message: '[429]: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
      status: 401,
    },
  });

  assert.deepEqual(messages, [{
    id: 'msg_provider_error-error',
    kind: 'error',
    markdown: 'Provider error [429]: Rate limit exceeded. Please try again later.',
  }]);
});

test('uses the provider status when the message has no embedded status', () => {
  const messages = toChatMessage({
    id: 'msg_plain_provider_error',
    type: 'assistant',
    content: [],
    finish: 'error',
    error: {
      type: 'provider.auth',
      message: 'Authentication failed.',
      status: 401,
    },
  });

  assert.equal(messages[0]?.markdown, 'Provider error [401]: Authentication failed.');
});

test('shows the terminal connection error for a failed idle session', () => {
  const messages = toChatMessage({
    id: 'msg_failed_session',
    type: 'idle',
    outcome: 'failed',
  });

  assert.deepEqual(messages, [{
    id: 'msg_failed_session-outcome',
    kind: 'error',
    markdown: 'ConnectionRefused: Unable to connect. Is the computer able to access the URL?',
  }]);
});

test('renders an execute tool row with its code, not an empty body', () => {
  const messages = toChatMessage({
    id: 'msg_execute',
    type: 'assistant',
    content: [{
      type: 'tool',
      name: 'execute',
      state: {
        status: 'completed',
        input: { code: 'const res = search({ query: "x" });\nreturn res;' },
        output: '{"items":[]}',
      },
    }],
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.kind, 'tool');
  assert.equal(messages[0]?.tool?.tool, 'execute');
  assert.ok((messages[0]?.tool?.input ?? '').includes('const res = search'));
});

test('shows the wrapper result on an execute subcall row', () => {
  const messages = toChatMessage({
    id: 'msg_exec_wrap',
    type: 'assistant',
    content: [{
      type: 'tool',
      name: 'execute',
      state: {
        status: 'completed',
        input: { code: 'const updated = await tools.kanban.kanban_update_board({projectId: "p1"});\nreturn updated;' },
        content: [{ type: 'text', text: '{\r\n  "id": "p1",\r\n  "name": "kanban-clone"\r\n}' }],
      },
      metadata: {
        toolCalls: [{
          tool: 'kanban.kanban_update_board',
          status: 'completed',
          input: { projectId: 'p1' },
        }],
      },
    }],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.tool?.tool, 'execute');
  assert.equal(messages[0]?.tool?.status, 'executed');
  assert.ok((messages[0]?.tool?.input ?? '').includes('kanban_update_board'));
  assert.ok((messages[0]?.tool?.output ?? '').includes('kanban-clone'));
  assert.equal(messages[1]?.tool?.tool, 'kanban.kanban_update_board');
  assert.equal(messages[1]?.tool?.status, 'executed');
  assert.ok((messages[1]?.tool?.input ?? '').includes('projectId'));
  assert.ok((messages[1]?.tool?.output ?? '').includes('kanban-clone'));
});

test('keeps a running execute row with its code', () => {
  const messages = toChatMessage({
    id: 'msg_exec_run',
    type: 'assistant',
    content: [{
      type: 'tool',
      name: 'execute',
      executed: false,
      state: {
        status: 'running',
        input: { code: 'const x = 1;\nreturn x;' },
      },
    }],
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.tool?.tool, 'execute');
  assert.equal(messages[0]?.tool?.status, 'running');
  assert.ok((messages[0]?.tool?.input ?? '').includes('const x = 1'));
});

test('renders apply_patch input as a file diff', () => {
  const messages = toChatMessage({
    id: 'msg_apply_patch',
    type: 'assistant',
    content: [{
      type: 'tool',
      name: 'apply_patch',
      state: {
        status: 'completed',
        input: {
          patchText: [
            '*** Begin Patch',
            '*** Update File: C:\\\\work\\\\app.ts',
            '@@',
            '-const oldValue = true;',
            '+const newValue = true;',
            ' context();',
            '*** End Patch',
          ].join('\n'),
        },
        output: 'Success. Updated the following files: app.ts',
      },
    }],
  });

  const tool = messages[0]?.tool;
  assert.equal(tool?.render, 'diff');
  assert.equal(tool?.filePath, 'C:\\\\work\\\\app.ts');
  assert.deepEqual(tool?.diff, [
    { type: 'hunk', text: '*** Update File: C:\\\\work\\\\app.ts' },
    { type: 'hunk', text: '@@' },
    { type: 'del', text: 'const oldValue = true;' },
    { type: 'add', text: 'const newValue = true;' },
    { type: 'ctx', text: 'context();' },
  ]);
});
