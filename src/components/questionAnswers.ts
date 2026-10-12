// Parse a `question` tool result into structured answer entries.
//
// The question tool records its answer as JSON (`{ q0: "label", q1: ["a","b"] }`
// or an envelope like `{ answers: {…} }`). The chat must never dump that raw
// JSON at the user, so this module turns it into one entry per question that
// the UI renders as a list of picked pills.

import type { QuestionItem } from './chatEvents';

/** Structured answer entries for the cool list — one per question. */
export interface QuestionAnswerEntry {
  header: string;
  question: string;
  answers: string[];
}

/** At least one question carries a pick — drives "hide raw result" logic. */
export function hasAnyAnswer(entries: QuestionAnswerEntry[]): boolean {
  return entries.some((e) => e.answers.length > 0);
}

function normalizeAnswerValue(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return (v as unknown[])
      .map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
      .filter(Boolean);
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const label = o.label ?? o.value ?? o.answer ?? o.selected ?? o.title;
    if (typeof label === 'string' && label.trim()) return [label.trim()];
    try {
      return [JSON.stringify(v).slice(0, 200)];
    } catch {
      return [String(v)];
    }
  }
  if (v != null) {
    const s = String(v).trim();
    return s ? [s] : [];
  }
  return [];
}

function entriesFromValues(
  values: unknown[],
  questions: QuestionItem[],
): QuestionAnswerEntry[] {
  if (questions.length === 0) {
    return [{
      header: 'Answer',
      question: '',
      answers: values.flatMap((v) => normalizeAnswerValue(v)),
    }];
  }
  if (values.length === questions.length) {
    return questions.map((q, i) => ({
      header: q.header,
      question: q.question,
      answers: normalizeAnswerValue(values[i]),
    }));
  }
  // Length mismatch: one flat answer list under the first question.
  return questions.map((q, i) => ({
    header: q.header,
    question: q.question,
    answers: i === 0 ? values.flatMap((v) => normalizeAnswerValue(v)) : [],
  }));
}

function singleEntry(text: string, questions: QuestionItem[]): QuestionAnswerEntry {
  const clean = text.replace(/\s+/g, ' ').slice(0, 400);
  const q = questions[0];
  return q
    ? { header: q.header, question: q.question, answers: [clean] }
    : { header: 'Answer', question: '', answers: [clean] };
}

const ENVELOPE_KEYS = ['answers', 'data', 'result', 'selections', 'selected', 'answer'] as const;

/**
 * Turn a question tool result into one entry per question.
 * Handles the direct `{ q0, q1 }` map, common envelopes, and plain text.
 * Never throws — a bad payload degrades to a single text entry.
 */
export function parseQuestionAnswers(
  raw?: string,
  questions: QuestionItem[] = [],
): QuestionAnswerEntry[] {
  const out = (raw ?? '').trim();
  if (!out) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    // Not JSON: plain text answer.
    return [singleEntry(out, questions)];
  }

  if (parsed == null || typeof parsed !== 'object') {
    const s = String(parsed ?? '').trim();
    return s ? [singleEntry(s, questions)] : [];
  }

  const o = parsed as Record<string, unknown>;

  // Direct `{ q0, q1, … }` map — the shape buildQuestionAnswer submits.
  if (Object.keys(o).some((k) => /^q\d+$/.test(k))) {
    return questions.map((q, i) => ({
      header: q.header,
      question: q.question,
      answers: normalizeAnswerValue(o[`q${i}`]),
    }));
  }

  // Envelope shapes: string, array, or nested object under a known key.
  for (const key of ENVELOPE_KEYS) {
    const v = o[key];
    if (v == null) continue;
    if (typeof v === 'string') {
      return v.trim() ? [singleEntry(v, questions)] : [];
    }
    if (Array.isArray(v)) {
      return entriesFromValues(v as unknown[], questions);
    }
    if (typeof v === 'object') {
      const map = v as Record<string, unknown>;
      if (questions.length === 0) {
        return [{
          header: 'Answer',
          question: '',
          answers: Object.values(map).flatMap((x) => normalizeAnswerValue(x)),
        }];
      }
      return questions.map((q, i) => {
        let value = map[`q${i}`] ?? map[String(i)] ?? map[q.header] ?? map[q.question];
        // Positional fallback: keys differ but count matches.
        if (value == null && Object.keys(map).length === questions.length) {
          value = Object.values(map)[i];
        }
        return { header: q.header, question: q.question, answers: normalizeAnswerValue(value) };
      });
    }
  }

  // Unknown object shape: compact text under the first question, never raw JSON.
  return [singleEntry(out, questions)];
}
