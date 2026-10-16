import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pairModel,
  parseModelString,
  formatModelRef,
  normalizeAllowedModels,
  isModelAllowed,
  resolveSessionModel,
} from './modelResolution.ts';

const PREF = { providerID: 'openai', modelID: 'gpt-5' };

test('pairModel requires both halves', () => {
  assert.deepEqual(pairModel('ollama', 'gemma4:e2b'), { providerID: 'ollama', modelID: 'gemma4:e2b' });
  assert.equal(pairModel('ollama', ''), null);
  assert.equal(pairModel('', 'gemma4:e2b'), null);
  assert.equal(pairModel(null, undefined), null);
  assert.equal(pairModel('  ', '  '), null);
});

test('parseModelString splits on the first slash only', () => {
  assert.deepEqual(parseModelString('ollama/gemma4:e2b'), { providerID: 'ollama', modelID: 'gemma4:e2b' });
  assert.deepEqual(parseModelString('anthropic/claude/v3'), { providerID: 'anthropic', modelID: 'claude/v3' });
  assert.equal(parseModelString('noprovider'), null);
  assert.equal(parseModelString('/leading'), null);
  assert.equal(parseModelString('trailing/'), null);
  assert.equal(parseModelString(''), null);
  assert.equal(parseModelString(null), null);
});

test('formatModelRef renders provider/model or empty', () => {
  assert.equal(formatModelRef({ providerID: 'ollama', modelID: 'gemma4:e2b' }), 'ollama/gemma4:e2b');
  assert.equal(formatModelRef(null), '');
});

test('normalizeAllowedModels trims, de-duplicates and drops malformed entries', () => {
  assert.deepEqual(
    normalizeAllowedModels([' ollama/llama3 ', 'ollama/llama3', 'noprovider', 'trailing/', '', null as never]),
    ['ollama/llama3']
  );
  assert.deepEqual(normalizeAllowedModels(undefined), []);
  assert.deepEqual(normalizeAllowedModels(null), []);
  // Selection order is preserved — resolveSessionModel uses the first entry.
  assert.deepEqual(
    normalizeAllowedModels(['b/m2', 'a/m1']),
    ['b/m2', 'a/m1']
  );
});

test('isModelAllowed: empty pool means unrestricted', () => {
  assert.equal(isModelAllowed('ollama/llama3', []), true);
  assert.equal(isModelAllowed('ollama/llama3', null), true);
  assert.equal(isModelAllowed('ollama/llama3', undefined), true);
  assert.equal(isModelAllowed('', []), true);
});

test('isModelAllowed: non-empty pool filters', () => {
  const pool = ['ollama/llama3', 'anthropic/claude/v3'];
  assert.equal(isModelAllowed('ollama/llama3', pool), true);
  assert.equal(isModelAllowed('anthropic/claude/v3', pool), true);
  assert.equal(isModelAllowed('openai/gpt-5', pool), false);
  assert.equal(isModelAllowed('', pool), false);
  assert.equal(isModelAllowed(null, pool), false);
});

test('isModelAllowed: a pool of unusable entries fails closed', () => {
  // Restriction was opted into, so garbage must not re-open every model.
  assert.equal(isModelAllowed('ollama/llama3', ['noprovider']), false);
  assert.equal(isModelAllowed('ollama/llama3', ['trailing/']), false);
});

test('resolveSessionModel: task pick wins over pref and pool', () => {
  const task = { modelProviderID: 'ollama', modelId: 'llama3' };
  assert.deepEqual(
    resolveSessionModel(task, { allowedModels: ['anthropic/claude'] }, PREF),
    { providerID: 'ollama', modelID: 'llama3' }
  );
});

test('resolveSessionModel: browser pref used when the project is unrestricted', () => {
  assert.deepEqual(
    resolveSessionModel({ modelId: null, modelProviderID: null }, { allowedModels: [] }, PREF),
    { providerID: 'openai', modelID: 'gpt-5' }
  );
  assert.deepEqual(resolveSessionModel(null, null, PREF), { providerID: 'openai', modelID: 'gpt-5' });
});

test('resolveSessionModel: pref kept when the project allows it', () => {
  const project = { allowedModels: ['anthropic/claude', 'openai/gpt-5'] };
  assert.deepEqual(resolveSessionModel(null, project, PREF), { providerID: 'openai', modelID: 'gpt-5' });
});

test('resolveSessionModel: pool enforced when pref is outside it', () => {
  const project = { allowedModels: ['anthropic/claude', 'ollama/llama3'] };
  assert.deepEqual(resolveSessionModel(null, project, PREF), { providerID: 'anthropic', modelID: 'claude' });
});

test('resolveSessionModel: first allowed model used when nothing else is set', () => {
  assert.deepEqual(
    resolveSessionModel(null, { allowedModels: ['ollama/llama3'] }, null),
    { providerID: 'ollama', modelID: 'llama3' }
  );
});

test('resolveSessionModel: null when nothing set (server default)', () => {
  assert.equal(resolveSessionModel(null, null, null), null);
  assert.equal(resolveSessionModel(null, { allowedModels: [] }, null), null);
});

test('resolveSessionModel: malformed pool falls back to the server default', () => {
  // Entries without a provider/… split can never be sent — do not 400 the session.
  assert.equal(resolveSessionModel(null, { allowedModels: ['noprovider'] }, null), null);
  assert.equal(resolveSessionModel(null, { allowedModels: ['noprovider'] }, PREF), null);
});

test('resolveSessionModel: half-filled task pair is skipped (never sent)', () => {
  const broken = { modelProviderID: 'ollama', modelId: '' };
  assert.deepEqual(resolveSessionModel(broken, { allowedModels: [] }, PREF), { providerID: 'openai', modelID: 'gpt-5' });
  assert.equal(resolveSessionModel(broken, null, null), null);
});
