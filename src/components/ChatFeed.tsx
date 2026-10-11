// Shared chat feed: ThinkingBlock + ToolRow + Bubble + status dot.
// Used by SessionChatWindow (task chat) and AssistantChatWindow (board chat)
// so both panels render the same styling and tool calls.

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, ChevronDown, Wrench, Check, AlertTriangle } from 'lucide-react';
import type { ChatStatus } from '../hooks/useSessionStream';
import type { ChatMessage } from './chatEvents';
import { linkifyFilePaths, parsePreviewHref } from './filePaths';

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
              components={{
                a: ({ href, children, ...props }) => {
                  const abs = parsePreviewHref(href);
                  if (abs) {
                    return <button type="button" title={abs} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFileClick(abs); }} className="underline mono text-[12px] break-all" style={{ color: 'var(--info)', cursor: 'pointer' }}>{children}</button>;
                  }
                  return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
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

export function ToolRow({ msg, onFileClick }: { msg: ChatMessage; onFileClick: (absPath: string) => void }) {
  const t = msg.tool;
  const executed = (t?.status ?? '').toLowerCase() === 'executed';
  const hasDiff = !!t?.diff && t.diff.length > 0;
  const [open, setOpen] = useState(hasDiff);
  const isWrite = (t?.tool ?? '').toLowerCase().includes('write') && !(t?.tool ?? '').toLowerCase().includes('todo');
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        {executed
          ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--emerald)' }} strokeWidth={1.75} />
          : <Wrench className="w-3.5 h-3.5 muted" strokeWidth={1.75} />}
      </div>
      <div className="flex-1 min-w-0 max-w-[88%]">
        <button onClick={() => setOpen((v) => !v)}
          className="btn w-full flex items-center gap-2 px-2.5 py-1.5 mono text-[11px] text-left">
          <span className="font-semibold shrink-0 t-strong">{t?.tool ?? 'tool'}</span>
          {t?.summary && <span className="muted truncate font-sans">{t.summary}</span>}
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
            ) : t?.input && (
              <div className="px-2.5 py-2 border-b hairline" style={{ borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
                <p className="text-[10px] uppercase tracking-widest muted mono mb-1">Input</p>
                <pre className="mono text-[11px] leading-relaxed t-soft whitespace-pre-wrap break-words">{t.input}</pre>
              </div>
            )}
            {t?.render === 'question' && t.questions ? (
              <div className="px-2.5 py-2 space-y-2">
                {t.questions.map((q, i) => (
                  <div key={i}>
                    <p className="text-[11px] font-semibold t-strong">{q.header}: {q.question}</p>
                    {q.options.map((o, j) => (
                      <p key={j} className="mono text-[11px] muted">· {o.label}{o.description ? ` — ${o.description}` : ''}</p>
                    ))}
                  </div>
                ))}
              </div>
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
            {t?.output ? (
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

export function ChatBubble({ msg, agentName, modelName, showAvatar = true, onFileClick }: { msg: ChatMessage; agentName?: string; modelName?: string; showAvatar?: boolean; onFileClick: (absPath: string) => void }) {
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
  return (
    <div className={`flex gap-2 animate-fadeIn ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (showAvatar ? (
        <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
          <Bot className="w-3.5 h-3.5 muted" strokeWidth={1.75} />
        </div>
      ) : <div className="w-6 shrink-0" />)}
      <div className={`min-w-0 max-w-[88%] ${isUser ? 'order-first' : ''}`}>
        {!isUser && showAvatar && agentName && (
          <p className="text-[10px] font-semibold uppercase tracking-widest muted mb-1 ml-1 mono">{agentName}</p>
        )}
        <div className="md-body text-[12.5px] leading-relaxed break-words"
          style={isUser
            ? { background: 'var(--accent)', color: 'var(--accent-text)', border: '1px solid var(--accent)', borderRadius: 6, padding: '8px 10px' }
            : { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, ...props }) => {
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
                return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
              },
            }}
          >{linkifyFilePaths(msg.markdown)}</Markdown>
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

export function ChatErrorRow({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 justify-start animate-fadeIn">
      <div className="w-6 h-6 flex items-center justify-center shrink-0" style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
        <AlertTriangle className="w-3.5 h-3.5" style={{ color: 'var(--danger)' }} strokeWidth={1.75} />
      </div>
      <div className="min-w-0 max-w-[88%] panel px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--danger)' }}>
        {msg.markdown}
      </div>
    </div>
  );
}
