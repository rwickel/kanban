import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEnv } from './env.mjs';

test('parses comments, Windows paths, and quoted values', () => {
  assert.deepEqual(parseEnv([
    '# local settings',
    'KANBAN_PROJECTS_ROOT=C:\\Users\\Robert\\work',
    'OPENCODE_SERVER_URL="http://127.0.0.1:4099"',
    "OPENCODE_SERVER_PASSWORD='secret value'",
  ].join('\n')), {
    KANBAN_PROJECTS_ROOT: 'C:\\Users\\Robert\\work',
    OPENCODE_SERVER_URL: 'http://127.0.0.1:4099',
    OPENCODE_SERVER_PASSWORD: 'secret value',
  });
});

test('keeps equals signs inside values', () => {
  assert.deepEqual(parseEnv('TOKEN=abc=def='), { TOKEN: 'abc=def=' });
});
