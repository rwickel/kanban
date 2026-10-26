// Answer helpers for a blocked `question` tool form.
//
// The question tool can attach options to a question and still accept a typed
// answer: `custom` is enabled by default, so the UI adds a "Type your own
// answer" field for every question that has options. Answers are keyed q0,
// q1, … — a label string for single-select fields, a label array for multiple.

import type { QuestionItem } from './chatEvents';

/** A typed answer wins over a pick; a pick is used when the text is blank. */
export function buildQuestionAnswer(
  questions: QuestionItem[],
  picks: Record<number, string[]>,
  texts: Record<number, string>,
): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const custom = (texts[i] ?? '').trim();
    if (q.freeText) {
      answer[`q${i}`] = custom;
    } else if (q.multiple) {
      const chosen = picks[i] ?? [];
      // A typed answer is an extra label, never a duplicate.
      answer[`q${i}`] = custom && !chosen.includes(custom) ? [...chosen, custom] : chosen;
    } else {
      answer[`q${i}`] = custom || (picks[i]?.[0] ?? '');
    }
  }
  return answer;
}

/** True when the question has a pick or a typed answer (single and multi). */
export function isQuestionAnswered(
  question: QuestionItem | undefined,
  picks: string[],
  text: string,
): boolean {
  if (!question) return false;
  const custom = text.trim().length > 0;
  return question.freeText ? custom : custom || picks.length > 0;
}
