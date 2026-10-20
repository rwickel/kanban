// Shared chat feed: ThinkingBlock + ToolRow + Bubble + status dot.
// Used by SessionChatWindow (task chat) and AssistantChatWindow (board chat)
// so both panels render the same styling and tool calls.

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, ChevronDown, Wrench, Check, Copy, AlertTriangle, Search, Pencil, Trash2, GitFork } from 'lucide-react';
import type { ChatStatus } from '../hooks/useSessionStream';
import type { ChatMessage, QuestionItem } from './chatEvents';
import { linkifyFilePaths, parsePreviewHref } from './filePaths';
import { externalLink } from './markdownLink';

function linkifyKanbanRefs(markdown: string): string {
  return markdown
    .replace(/(Task ID:\s*)([0-9a-f]{8}-[0-9a-f-]{27,})/gi, '$1[$2](kanban-task:$2)')
    .replace(/(Session ID:\s*)(ses_[A-Za-z0-9_-]+)/g, '$1[$2](kanban-session:$2)');
}

export const STATUS_DOT: Record<ChatStatus, { bg: string; label: string; pulse: boolean }> = {
  idle: { bg: 'var(--muted)', label: 'idle', pulse: false },
  connecting: { bg: 'var(--amber)', label: 'connecting', pulse: true },
  live: { bg: 'var(--emerald)', label: 'live', pulse: true },
  closed: { bg: 'var(--muted)', label: 'closed', pulse: false },
  error: { bg: 'var(--danger)', label: 'stream error', pulse: false },
  'no-run': { bg: 'var(--muted)', label: 'no session', pulse: false },
};

export function formatElapsed(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ThinkingBlock({ msg, showAvatar, agentName, modelName, onFileClick }: { msg: ChatMessage; showAvatar?: boolean; agentName?: string; modelName?: string; onFileClick: (absPath: string) => void }) {
  const [open, setOpen] = useState(false);
  const fmtFull = (n: number) => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
  const footerBits: string[] = [];
  const fAgent = msg.meta?.agent ?? agentName;
  const fModel = msg.meta?.model ?? modelName;
  const fElapsed = formatElapsed(msg.meta?.elapsedMs);
  const fInTok = msg.meta?.inputTokens ?? 0;
  const fOutTok = msg.meta?.outputTokens ?? 0;
  const fReasTok = msg.meta?.reasoningTokens ?? 0;
  const fTotal = msg.meta?.totalTokens ?? (fInTok + fOutTok + fReasTok);
  const fHasTokens = fTotal > 0 || fInTok > 0 || fOutTok > 0;
  if (fAgent) footerBits.push(fAgent);
  if (fModel) footerBits.push(fModel);
  if (fElapsed) footerBits.push(`⏱ ${fElapsed}`);
  if (fHasTokens) {
    if (fInTok > 0 || fOutTok > 0) footerBits.push(`in ${fmtFull(fInTok)} · out ${fmtFull(fOutTok)}`);
    else footerBits.push(`⬡ ${fmtFull(fTotal)}`);
    if (fReasTok > 0) footerBits.push(`reasoning ${fmtFull(fReasTok)}`);
    if ((fInTok > 0 || fOutTok > 0) && fTotal > 0) footerBits.push(`total ${fmtFull(fTotal)}`);
  }
  if (msg.meta?.cost != null && msg.meta.cost > 0) footerBits.push(msg.meta.cost < 0.01 ? `$${msg.meta.cost.toFixed(4)}` : `$${msg.meta.cost.toFixed(2)}`);
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      {showAvatar ? (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <Bot className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      ) : (
        <div className="w-6 shrink-0" />
      )}
      <div className="flex-1 min-w-0 max-w-[88%]">
        {showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest muted mb-1 ml-1 mono">{agentName}</p>
        )}
        <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 text-[11px] muted hoverable">
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
          <span className="font-medium mono uppercase tracking-wide">Thinking</span>
        </button>
        {open && (
          <div className="mt-1 panel p-2.5 text-[11.5px] leading-relaxed t-soft break-words md-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(u) => u}
              components={{
                a: ({ href, children, node, ...props }) => {
                  const abs = parsePreviewHref(href);
                  if (abs) {
                    return <button type="button" title={abs} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFileClick(abs); }} className="underline mono text-[12px] break-all" style={{ color: 'var(--info)', cursor: 'pointer' }}>{children}</button>;
                  }
                  return externalLink(href, children);
                },
              }}
            >{linkifyFilePaths(msg.markdown)}</Markdown>
            {footerBits.length > 0 && (
              <p className="text-[10px] muted mono mt-2 pt-1.5 border-t hairline" style={{ borderTopWidth: 1, borderTopStyle: 'solid' }}>
                {footerBits.join(' · ')}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Serialize the picks into the form answer the backend expects: { q0, q1, … }. */
function buildQuestionAnswer(questions: QuestionItem[], picks: Record<number, string[]>, texts: Record<number, string>): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.freeText) answer[`q${i}`] = (texts[i] ?? '').trim();
    else answer[`q${i}`] = q.multiple ? (picks[i] ?? []) : (picks[i]?.[0] ?? '');
  }
  return answer;
}

/** Structured answer entries for the cool list — one per question. */
export interface QuestionAnswerEntry { header: string; question: string; answers: string[]; }

function normalizeAnswerValue(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return (v as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : String(x).trim())).filter(Boolean);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const label = o.label ?? o.value ?? o.answer ?? o.selected ?? o.title;
    if (typeof label === 'string' && label.trim()) return [label.trim()];
    try { return [JSON.stringify(v).slice(0, 200)]; } catch { return [String(v)]; }
  }
  if (v != null) { const s = String(v).trim(); return s ? [s] : []; }
  return [];
}

export function parseQuestionAnswers(raw?: string, questions: QuestionItem[] = []): QuestionAnswerEntry[] {
  const out = (raw ?? '').trim();
  if (!out) return [];
  let parsed: unknown = null;
  let isJson = false;
  try { parsed = JSON.parse(out); isJson = true; } catch { /* plain text */ }
  if (!isJson) {
    const clean = out.replace(/\s+/g, ' ').slice(0, 400);
    if (!questions.length) return [{ header: 'Answer', question: '', answers: [clean] }];
    // Plain text with single question: show as its answer
    if (questions.length === 1) return [{ header: questions[0].header, question: questions[0].question, answers: [clean] }];
    return [{ header: questions[0].header, question: questions[0].question, answers: [clean] }];
  }
  if (parsed == null || typeof parsed !== 'object') {
    const s = String(parsed ?? '').trim();
    if (!s) return [];
    if (questions.length) return [{ header: questions[0].header, question: questions[0].question, answers: [s] }];
    return [{ header: 'Answer', question: '', answers: [s] }];
  }
  const o = parsed as Record<string, unknown>;
  // Direct q0 map at top level? e.g. { q0: "a", q1: ["b","c"] }
  const hasQKeys = Object.keys(o).some((k) => /^q\d+$/.test(k));
  let map: Record<string, unknown> | null = null;
  if (hasQKeys) map = o;
  else {
    const envelopeKeys = ['answers', 'data', 'result', 'selections', 'selected', 'answer'] as const;
    for (const k of envelopeKeys) {
      const v = o[k];
      if (v == null) continue;
      if (typeof v === 'string') {
        if (questions.length) return [{ header: questions[0].header, question: questions[0].question, answers: [v] }];
        return [{ header: 'Answer', question: '', answers: [v] }];
      }
      if (Array.isArray(v)) {
        // Array envelope: distribute per question when lengths match, else single-question list
        const arr = (v as unknown[]).map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            const q = item as Record<string, unknown>;
            const label = q.label ?? q.answer ?? q.value ?? q.selected ?? q.title;
            return typeof label === 'string' ? label : JSON.stringify(q).slice(0, 200);
          }
          return String(item);
        }).filter(Boolean) as string[];
        if (questions.length === 0) return [{ header: 'Answer', question: '', answers: arr }];
        if (questions.length === 1) return [{ header: questions[0].header, question: questions[0].question, answers: arr }];
        if (arr.length === questions.length) {
          return questions.map((q, i) => ({ header: q.header, question: q.question, answers: arr[i] ? [arr[i]] : [] }));
        }
        // Fallback: all answers under first question
        return questions.map((q, i) => ({ header: q.header, question: q.question, answers: i === 0 ? arr : [] }));
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) { map = v as Record<string, unknown>; break; }
    }
  }
  if (map) {
    return questions.map((q, i) => {
      const key = `q${i}`;
      let v: unknown = (map as Record<string, unknown>)[key] ?? (map as Record<string, unknown>)[String(i)];
      // Also try header/question as key
      if (v == null) v = (map as Record<string, unknown>)[q.header] ?? (map as Record<string, unknown>)[q.question];
      // Positional fallback when map is ordered but keys are different
      if (v == null && Object.keys(map as Record<string, unknown>).length === questions.length) {
        v = Object.values(map as Record<string, unknown>)[i];
      }
      return { header: q.header, question: q.question, answers: normalizeAnswerValue(v) };
    });
  }
  // No recognized envelope: show raw compact text under first question
  const fallback = out.replace(/\s+/g, ' ').slice(0, 400);
  if (questions.length) return [{ header: questions[0].header, question: questions[0].question, answers: [fallback] }];
  return [{ header: 'Answer', question: '', answers: [fallback] }];
}

function hasAnyAnswer(entries: QuestionAnswerEntry[]): boolean {
  return entries.some((e) => e.answers.length > 0);
}

/** Cool answer list — replaces raw JSON with pills and per-question rows. */
function QuestionAnswerList({ entries }: { entries: QuestionAnswerEntry[] }) {
  if (!entries.length || !hasAnyAnswer(entries)) return null;
  return (
    <div
      className="panel overflow-hidden"
      style={{
        background: 'var(--surface)',
        borderColor: 'color-mix(in srgb, var(--emerald) 28%, var(--border))',
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        style={{
          background: 'color-mix(in srgb, var(--emerald) 9%, var(--surface-2))',
          borderBottom: '1px solid color-mix(in srgb, var(--emerald) 18%, var(--border))',
        }}
      >
        <span
          className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
          style={{ background: 'color-mix(in srgb, var(--emerald) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--emerald) 30%, transparent)' }}
        >
          <Check className="w-3 h-3" style={{ color: 'var(--emerald)' }} strokeWidth={2.5} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-widest mono" style={{ color: 'var(--emerald)' }}>
          Answer{entries.length > 1 ? 's' : ''}
        </span>
        <span className="text-[10px] mono muted">— {entries.reduce((n, e) => n + e.answers.length, 0)} pick{entries.reduce((n, e) => n + e.answers.length, 0) === 1 ? '' : 's'}</span>
      </div>
      <ul className="px-2.5 py-2 space-y-2.5">
        {entries.map((e, i) => (
          <li key={i} className="flex gap-2.5">
            <span
              className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold mono"
              style={{
                background: 'color-mix(in srgb, var(--emerald) 12%, transparent)',
                color: 'var(--emerald)',
                border: '1px solid color-mix(in srgb, var(--emerald) 22%, transparent)',
              }}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] leading-snug flex flex-wrap items-baseline gap-1">
                <span className="pill p-green text-[9px] px-1.5 py-0 leading-none" style={{ fontSize: 9 }}>{e.header || 'Question'}</span>
                <span className="font-semibold t-strong">{e.question}</span>
              </p>
              {e.answers.length > 0 ? (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {e.answers.map((a, j) => (
                    <span
                      key={j}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium mono max-w-full"
                      style={{
                        background: 'color-mix(in srgb, var(--emerald) 11%, var(--surface-2))',
                        border: '1px solid color-mix(in srgb, var(--emerald) 26%, transparent)',
                        color: 'var(--emerald)',
                      }}
                    >
                      <Check className="w-3 h-3 shrink-0" strokeWidth={2.2} />
                      <span className="truncate">{a}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] muted mono mt-1">— no pick</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Interactive question card: checkbox list for options, text field when the
 * question has none. Submit stays disabled until every question is answered.
 */
function QuestionCard({
  msg,
  onAnswered,
}: {
  msg: ChatMessage;
  onAnswered?: (toolCallId: string, answer: Record<string, string | string[]>) => void;
}) {
  const t = msg.tool!;
  const questions = t.questions ?? [];
  const done = (t.status ?? '').toLowerCase() === 'executed';
  const answerEntries = done ? parseQuestionAnswers(t.output, questions) : [];
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);

  const isAnswered = (i: number) => {
    const q = questions[i];
    if (!q) return false;
    return q.freeText ? (texts[i] ?? '').trim().length > 0 : (picks[i]?.length ?? 0) > 0;
  };
  const allAnswered = questions.length > 0 && questions.every((_, i) => isAnswered(i));
  const canSubmit = !done && !sent && allAnswered && !!t.toolCallId && !!onAnswered;

  const toggle = (i: number, label: string) => {
    setPicks((prev) => {
      const cur = prev[i] ?? [];
      if (questions[i]?.multiple) {
        return { ...prev, [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      // Single-select: picking the active label clears it.
      return { ...prev, [i]: cur.includes(label) ? [] : [label] };
    });
  };

  const submit = () => {
    if (!canSubmit || !t.toolCallId) return;
    setSent(true);
    onAnswered!(t.toolCallId, buildQuestionAnswer(questions, picks, texts));
  };

  return (
    <div className="px-2.5 py-2.5 space-y-2.5">
      {questions.map((q, i) => {
        const picked = picks[i] ?? [];
        return (
          <div key={i} className="panel overflow-hidden" style={{ background: 'var(--surface-2)' }}>
            <div
              className="px-2.5 py-1.5 border-b hairline"
              style={{ borderBottomWidth: 1, borderBottomStyle: 'solid', background: 'var(--surface)' }}
            >
              <span
                className="text-[10px] font-semibold uppercase tracking-widest mono"
                style={{ color: 'var(--blue)' }}
              >
                {q.header || 'Question'}
              </span>
            </div>
            <div className="px-2.5 py-2">
              <p className="text-[12px] font-semibold t-strong leading-snug">{q.question}</p>
              {q.freeText ? (
                <input
                  type="text"
                  value={texts[i] ?? ''}
                  disabled={done}
                  onChange={(e) => setTexts((p) => ({ ...p, [i]: e.target.value }))}
                  placeholder="Type your answer…"
                  className="input mt-2 mono text-[11.5px]"
                  style={{ padding: '6px 8px', fontSize: '11.5px' }}
                />
              ) : (
                <ul className="mt-2 space-y-1">
                  {q.options.map((o, j) => {
                    const on = picked.includes(o.label);
                    const Input = q.multiple ? 'input' : 'input';
                    return (
                      <li key={j}>
                        <label
                          className="flex gap-1.5 items-start text-[11px] cursor-pointer rounded px-1 py-0.5"
                          style={{ background: on ? 'color-mix(in srgb, var(--blue) 8%, transparent)' : 'transparent' }}
                        >
                          <Input
                            type={q.multiple ? 'checkbox' : 'radio'}
                            name={`q-${i}`}
                            checked={on}
                            disabled={done}
                            onChange={() => toggle(i, o.label)}
                            className="shrink-0 mt-0.5"
                            style={{ accentColor: 'var(--blue)', cursor: done ? 'default' : 'pointer' }}
                          />
                          <span className="min-w-0">
                            <span className="mono t-soft">{o.label}</span>
                            {o.description && <span className="muted"> — {o.description}</span>}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        );
      })}
      {done && <QuestionAnswerList entries={answerEntries} />}
      {!done && onAnswered && (
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="btn px-3 py-1.5 text-[11px] font-semibold mono"
            style={canSubmit
              ? { background: 'var(--accent)', color: 'var(--accent-text)', borderColor: 'var(--accent)', cursor: 'pointer' }
              : { opacity: 0.55, cursor: 'not-allowed' }}
          >
            {sent ? 'sent' : 'submit'}
          </button>
          {!allAnswered && (
            <span className="text-[10px] muted mono">
              answer every question to continue
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export interface ReviewTarget { messageId: string; kind: 'tool' | 'assistant'; tool?: string; input?: string; output?: string; markdown?: string }
export function ToolRow({ msg, onFileClick, onAnswered, onReview }: { msg: ChatMessage; onFileClick: (absPath: string) => void; onAnswered?: (toolCallId: string, answer: Record<string, string | string[]>) => void; onReview?: (target: ReviewTarget) => void }) {
  const t = msg.tool;
  const executed = (t?.status ?? '').toLowerCase() === 'executed';
  const hasDiff = !!t?.diff && t.diff.length > 0;
  const isQuestion = t?.render === 'question' && !!t.questions?.length;
  const [open, setOpen] = useState(hasDiff || isQuestion);
  const isWrite = (t?.tool ?? '').toLowerCase().includes('write') && !(t?.tool ?? '').toLowerCase().includes('todo');
  const pendingQuestion = isQuestion && !executed;
  // Tool result doubles as the recorded answer when the question already ran.
  const hasQuestionAnswer = executed && hasAnyAnswer(parseQuestionAnswers(t?.output, t?.questions ?? []));
  // Question rows name the tool only — the question itself is the body.
  const lineSummary = isQuestion ? '' : t?.summary;
  const statusLabel = pendingQuestion ? 'waiting for answer' : lineSummary;
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        {executed
          ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} />
          : <Wrench className="w-3.5 h-3.5" style={{ color: pendingQuestion ? 'var(--amber)' : undefined }} strokeWidth={1.75} />}
      </div>
      <div className="flex-1 min-w-0 max-w-[88%]">
        <button onClick={() => setOpen((v) => !v)}
          className="btn w-full flex items-center gap-2 px-2.5 py-1.5 mono text-[11px] text-left">
          <span className="font-semibold shrink-0 t-strong">{t?.tool ?? 'tool'}</span>
          {statusLabel && (
            <span className="truncate font-sans" style={{ color: pendingQuestion ? 'var(--amber)' : 'var(--muted)' }}>
              {statusLabel}
            </span>
          )}
          {executed && onReview && <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onReview({ messageId: msg.id, kind: 'tool', tool: t?.tool, input: t?.input, output: t?.output }); }} className="btn p-1 shrink-0" title="Review this tool result" aria-label="Review this tool result"><Search className="w-3 h-3" strokeWidth={1.75} /></span>}
          <ChevronDown className={`w-3 h-3 shrink-0 muted transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
        </button>
        {open && (
          <div className="mt-1 panel overflow-hidden">
            {t?.filePath && (
              <div className="px-2.5 pt-2">
                <button type="button" title={t.filePath} onClick={() => onFileClick(t.filePath!)}
                  className="mono text-[11px] t-strong truncate underline text-left max-w-full block" style={{ cursor: 'pointer' }}>
                  {t.filePath}
                </button>
              </div>
            )}
            {hasDiff ? (
              <div className="px-2.5 py-2">
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">
                  {isWrite ? 'Content' : 'Diff'}
                </p>
                <pre className="mono text-[11px] leading-relaxed whitespace-pre-wrap break-words overflow-x-auto" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 0', maxHeight: 320, overflowY: 'auto' }}>
                  {t!.diff!.map((d, i) => (
                    <div
                      key={i}
                      style={d.type === 'add'
                        ? { background: 'color-mix(in srgb, var(--emerald) 14%, transparent)', padding: '1px 10px' }
                        : d.type === 'del'
                          ? { background: 'color-mix(in srgb, var(--danger) 12%, transparent)', padding: '1px 10px' }
                          : { padding: '1px 10px' }}
                    >
                      {d.text === '' ? ' ' : d.text}
                    </div>
                  ))}
                </pre>
              </div>
            ) : !isQuestion && t?.input && (
              <div className="px-2.5 py-2 border-b hairline" style={{ borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">Input</p>
                <pre className="mono text-[11px] leading-relaxed t-soft whitespace-pre-wrap break-words">{t.input}</pre>
              </div>
            )}
            {isQuestion ? (
              <QuestionCard msg={msg} onAnswered={onAnswered} />
            ) : null}
            {t?.render === 'todo' && t.todos ? (
              <div className="px-2.5 py-2 space-y-1">
                {t.todos.map((td, i) => (
                  <p key={i} className="mono text-[11px] t-soft">
                    {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '◐' : '○'} {td.content}
                  </p>
                ))}
              </div>
            ) : null}
            {t?.output && !(isQuestion && hasQuestionAnswer) ? (
              <div className="px-2.5 py-2">
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">Result</p>
                <pre className="mono text-[11px] leading-relaxed muted whitespace-pre-wrap break-words">{t.output}</pre>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatBubble({ msg, agentName, modelName, showAvatar = true, onFileClick, onTaskClick, onReview, onEdit, onClear, onFork }: { msg: ChatMessage; agentName?: string; modelName?: string; showAvatar?: boolean; onFileClick: (absPath: string) => void; onTaskClick?: (kind: 'task' | 'session', id: string) => void; onReview?: (target: ReviewTarget) => void; onEdit?: (msg: ChatMessage) => void; onClear?: (msg: ChatMessage) => void; onFork?: (msg: ChatMessage) => void }) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.markdown);
  const [forkNotice, setForkNotice] = useState(false);
  const isUser = msg.kind === 'user';
  const metaAgent = msg.meta?.agent ?? agentName;
  const metaModel = msg.meta?.model ?? modelName;
  const elapsed = formatElapsed(msg.meta?.elapsedMs);
  const inTok = msg.meta?.inputTokens ?? 0;
  const outTok = msg.meta?.outputTokens ?? 0;
  const reasTok = msg.meta?.reasoningTokens ?? 0;
  const total = msg.meta?.totalTokens ?? (inTok + outTok + reasTok);
  const hasTokens = total > 0 || inTok > 0 || outTok > 0;
  const cost = msg.meta?.cost;
  const hasCost = cost != null && Number.isFinite(cost) && cost > 0;
  const fmtFull = (n: number) => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
  const metaBits: string[] = [];
  if (metaAgent) metaBits.push(metaAgent);
  if (metaModel) metaBits.push(metaModel);
  if (elapsed) metaBits.push(`⏱ ${elapsed}`);
  if (hasTokens) {
    if (inTok > 0 || outTok > 0) metaBits.push(`in ${fmtFull(inTok)} · out ${fmtFull(outTok)}`);
    else metaBits.push(`⬡ ${fmtFull(total)}`);
    if (reasTok > 0) metaBits.push(`reasoning ${fmtFull(reasTok)}`);
    if ((inTok > 0 || outTok > 0) && total > 0) metaBits.push(`total ${fmtFull(total)}`);
  }
  if (hasCost) metaBits.push(cost! < 0.01 ? `$${cost!.toFixed(4)}` : `$${cost!.toFixed(2)}`);
  const metaTitle = [
    metaAgent ? `agent: ${metaAgent}` : null,
    metaModel ? `model: ${metaModel}` : null,
    hasTokens
      ? `input: ${fmtFull(inTok)} · output: ${fmtFull(outTok)}${reasTok > 0 ? ` · reasoning: ${fmtFull(reasTok)}` : ''} · total: ${fmtFull(total)}`
      : null,
    elapsed ? `elapsed: ${elapsed}` : null,
    hasCost ? `cost: $${cost!.toFixed(4)}` : null,
  ].filter(Boolean).join('\n');
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(msg.markdown);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = msg.markdown;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={`flex gap-2 animate-fadeIn ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (showAvatar ? (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <Bot className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      ) : <div className="w-6 shrink-0" />)}
       <div className={`min-w-0 w-full max-w-[88%] ${isUser ? 'order-first' : ''}`}>
        {!isUser && showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest muted mb-1 ml-1 mono">{agentName}</p>
        )}
         <div className="md-body relative w-full text-[12.5px] leading-relaxed break-words"
          style={isUser
            ? { background: 'var(--accent)', color: 'var(--accent-text)', border: '1px solid var(--accent)', borderRadius: 6, padding: '8px 10px 28px' }
            : { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px 28px' }}>
          {editing ? <div className="w-full max-w-full"><textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(3, Math.min(8, draft.split('\n').length + 1))} className="w-full resize-y bg-transparent outline-none text-[13px] leading-relaxed" aria-label="Edit message" /><div className="flex justify-end items-center gap-2 mt-2"><button type="button" className="btn px-3 py-1.5 rounded-full" style={{ color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent-text) 18%, var(--accent))', borderColor: 'color-mix(in srgb, var(--accent-text) 35%, var(--accent))' }} onClick={() => { setDraft(msg.markdown); setEditing(false); }}>Cancel</button><button type="button" className="btn px-3 py-1.5 rounded-full" style={{ color: 'var(--accent-text)', background: 'var(--accent)', borderColor: 'var(--accent)' }} disabled={!draft.trim()} onClick={() => { onEdit?.({ ...msg, markdown: draft.trim() }); setEditing(false); }}>Send</button></div></div> : <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(u) => u}
            components={{
              a: ({ href, children, node, ...props }) => {
                if (href?.startsWith('kanban-task:') || href?.startsWith('kanban-session:')) {
                  const kind = href.startsWith('kanban-task:') ? 'task' : 'session';
                  const prefix = kind === 'task' ? 'kanban-task:' : 'kanban-session:';
                  const id = href.slice(prefix.length);
                  return <button type="button" className="underline mono break-all" style={{ color: 'var(--info)', cursor: 'pointer' }} onClick={() => onTaskClick?.(kind, id)} title={`Open ${kind} ${id}`}>{children}</button>;
                }
                const abs = parsePreviewHref(href);
                if (abs) {
                  return (
                    <button
                      type="button"
                      title={abs}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFileClick(abs); }}
                      className="underline mono text-[12px] break-all"
                      style={{ color: 'var(--info)', cursor: 'pointer' }}
                    >
                      {children}
                    </button>
                  );
                }
                return externalLink(href, children);
              },
            }}
          >{linkifyKanbanRefs(linkifyFilePaths(msg.markdown))}</Markdown>}
          {onReview && !isUser && msg.markdown.trim() && <button type="button" onClick={() => onReview({ messageId: msg.id, kind: 'assistant', markdown: msg.markdown })} className="btn absolute right-7 bottom-1 inline-flex items-center justify-center p-1" title="Review this message" aria-label="Review this message"><Search className="w-3 h-3" strokeWidth={1.75} /></button>}
          {onEdit && isUser && !editing && <button type="button" onClick={() => { setDraft(msg.markdown); setEditing(true); }} className="btn absolute left-1 bottom-1 z-10 inline-flex items-center justify-center p-1" style={{ color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent-text) 18%, var(--accent))', borderColor: 'color-mix(in srgb, var(--accent-text) 35%, var(--accent))' }} title="Edit message" aria-label="Edit message"><Pencil className="w-3 h-3" strokeWidth={1.75} /></button>}
          {onClear && isUser && !editing && <button type="button" onClick={() => onClear(msg)} className="btn absolute left-7 bottom-1 z-10 inline-flex items-center justify-center p-1" style={{ color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent-text) 18%, var(--accent))', borderColor: 'color-mix(in srgb, var(--accent-text) 35%, var(--accent))' }} title="Clear this and following messages" aria-label="Clear this and following messages"><Trash2 className="w-3 h-3" strokeWidth={1.75} /></button>}
          {onFork && isUser && !editing && <button type="button" onClick={async () => { await onFork(msg); setForkNotice(true); window.setTimeout(() => setForkNotice(false), 2200); }} className="btn absolute left-[52px] bottom-1 z-10 inline-flex items-center justify-center p-1" style={{ color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent-text) 18%, var(--accent))', borderColor: 'color-mix(in srgb, var(--accent-text) 35%, var(--accent))' }} title="Fork into new task" aria-label="Fork into new task"><GitFork className="w-3 h-3" strokeWidth={1.75} /></button>}
          {forkNotice && <span className="fixed left-1/2 bottom-6 z-[100] -translate-x-1/2 rounded-lg px-4 py-2.5 text-[12px] font-semibold mono whitespace-nowrap shadow-lg" style={{ background: 'var(--emerald)', color: 'var(--bg)', border: '1px solid var(--emerald)' }}>✓ Forked chat into new task</span>}
          <button
            type="button"
            onClick={copyMessage}
            className="btn absolute right-1 bottom-1 inline-flex items-center justify-center p-1"
            style={isUser ? { color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent-text) 18%, var(--accent))', borderColor: 'color-mix(in srgb, var(--accent-text) 35%, var(--accent))' } : undefined}
            title={copied ? 'Copied' : 'Copy message'}
            aria-label={copied ? 'Message copied' : 'Copy message'}
          >
            {copied ? <Check className="w-3 h-3" style={{ color: isUser ? 'var(--accent-text)' : 'var(--emerald)' }} strokeWidth={1.75} /> : <Copy className="w-3 h-3" strokeWidth={1.75} />}
          </button>
        </div>
        {!isUser && metaBits.length > 0 && (
          <p className="text-[10px] muted mono mt-1 ml-1 truncate" title={metaTitle}>
            {metaBits.join(' · ')}
          </p>
        )}
      </div>
      {isUser && (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6 }}>
          <User className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      )}
    </div>
  );
}

export function ChatErrorRow({ msg, detail, onReview }: { msg: ChatMessage; detail?: string | null; onReview?: (target: ReviewTarget) => void }) {
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--danger)' }} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 max-w-[88%] panel px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words relative" style={{ color: 'var(--danger)' }}>
        {msg.markdown}
        {detail && <><br />{detail}</>}
        {onReview && <button type="button" onClick={() => onReview({ messageId: msg.id, kind: 'tool', tool: msg.tool?.tool, input: msg.tool?.input, output: msg.markdown })} className="btn inline-flex items-center justify-center p-1 ml-2" title="Review failed tool call" aria-label="Review failed tool call"><Search className="w-3 h-3" strokeWidth={1.75} /></button>}
      </div>
    </div>
  );
}
