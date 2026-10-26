import assert from 'node:assert/strict';
import test from 'node:test';

import type { QuestionItem } from './chatEvents.ts';
import { buildQuestionAnswer, isQuestionAnswered } from './questionForm.ts';

function question(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    header: 'Pick',
    question: 'Which one?',
    options: [{ label: 'a', description: '' }, { label: 'b', description: '' }],
    freeText: false,
    ...overrides,
  };
}

test('single-select: a pick becomes a label string', () => {
  const answers = buildQuestionAnswer([question()], { 0: ['b'] }, {});
  assert.deepEqual(answers, { q0: 'b' });
});

test('single-select: a typed answer wins over a pick', () => {
  const answers = buildQuestionAnswer([question()], { 0: ['a'] }, { 0: '  custom  ' });
  assert.deepEqual(answers, { q0: 'custom' });
});

test('single-select: no input becomes an empty string', () => {
  const answers = buildQuestionAnswer([question()], {}, { 0: '   ' });
  assert.deepEqual(answers, { q0: '' });
});

test('multi-select: a typed answer is added to the picks', () => {
  const q = question({ multiple: true });
  const answers = buildQuestionAnswer([q], { 0: ['a', 'b'] }, { 0: 'custom' });
  assert.deepEqual(answers, { q0: ['a', 'b', 'custom'] });
});

test('multi-select: a repeated typed answer is not added twice', () => {
  const q = question({ multiple: true });
  const answers = buildQuestionAnswer([q], { 0: ['a', 'custom'] }, { 0: 'custom' });
  assert.deepEqual(answers, { q0: ['a', 'custom'] });
});

test('free text questions use the typed answer only', () => {
  const q = question({ options: [], freeText: true });
  const answers = buildQuestionAnswer([q], { 0: ['ignored'] }, { 0: 'typed' });
  assert.deepEqual(answers, { q0: 'typed' });
});

test('answers are keyed by question index', () => {
  const answers = buildQuestionAnswer(
    [question(), question({ options: [], freeText: true })],
    { 0: ['a'] },
    { 1: 'second' },
  );
  assert.deepEqual(answers, { q0: 'a', q1: 'second' });
});

test('a question is answered by a pick or a typed answer', () => {
  assert.equal(isQuestionAnswered(question(), [], ''), false);
  assert.equal(isQuestionAnswered(question(), ['a'], ''), true);
  assert.equal(isQuestionAnswered(question(), [], 'custom'), true);
  assert.equal(isQuestionAnswered(question(), [], '   '), false);
});

test('free text questions need a typed answer', () => {
  const q = question({ options: [], freeText: true });
  assert.equal(isQuestionAnswered(q, [], ''), false);
  assert.equal(isQuestionAnswered(q, ['stale'], ''), false);
  assert.equal(isQuestionAnswered(q, [], 'typed'), true);
  assert.equal(isQuestionAnswered(undefined, ['a'], 'typed'), false);
});
