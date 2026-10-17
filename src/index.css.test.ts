import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('.md-body code sets an explicit theme text color', async () => {
  const css = await readFile(new URL('./index.css', import.meta.url), 'utf8');
  const rule = css.match(/\.md-body code\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(rule, /color:\s*var\(--text\)/);
});
