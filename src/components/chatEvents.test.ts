import assert from 'node:assert/strict';
import test from 'node:test';

import { toChatMessage } from './chatEvents.ts';

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
