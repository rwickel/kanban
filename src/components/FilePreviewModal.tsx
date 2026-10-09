import { useEffect, useState } from 'react';
import { X, FileText, GitCompare, Loader2 } from 'lucide-react';

type Tab = 'content' | 'diff';

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

export default function FilePreviewModal({
  absPath,
  onClose,
}: {
  absPath: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('content');
  const [content, setContent] = useState<string | null>(null);
  const [rel, setRel] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffDirty, setDiffDirty] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setContent(null);
    setDiff(null);
    setTab('content');
    (async () => {
      try {
        const r = await fetch(`/api/kanban/file?path=${encodeURIComponent(absPath)}`);
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        setContent(j.content ?? '');
        setRel(j.rel ?? '');
        setTruncated(Boolean(j.truncated));
      } catch (e: unknown) {
        if (!cancelled) setErr(String((e as Error)?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [absPath]);

  const loadDiff = async () => {
    if (diff !== null) return;
    try {
      const r = await fetch(`/api/kanban/file/diff?path=${encodeURIComponent(absPath)}`);
      const j = await r.json();
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      setDiff(j.diff ?? '');
      setDiffDirty(Boolean(j.dirty));
    } catch (e: unknown) {
      setDiff('');
      setDiffDirty(false);
      setErr(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[85vh] flex flex-col modal-card shadow-xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b hairline" style={{ borderBottomWidth: 1, borderBottomStyle: 'solid' }}>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest muted mono">File</p>
            <p className="text-[13px] font-semibold t-strong truncate mono" title={absPath}>{basename(absPath)}</p>
            <p className="text-[11px] muted mono truncate" title={absPath}>{rel || absPath}</p>
          </div>
          <button type="button" onClick={onClose} className="btn p-2 shrink-0" title="Close"><X className="w-4 h-4" strokeWidth={1.75} /></button>
        </div>

        <div className="flex items-center gap-1 px-4 pt-2 border-b hairline" style={{ borderBottomWidth: 1, borderBottomStyle: 'solid', background: 'var(--surface-2)' }}>
          <button type="button" onClick={() => setTab('content')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium mono ${tab === 'content' ? 't-strong' : 'muted'}`}
            style={tab === 'content' ? { borderBottom: '2px solid var(--accent)' } : undefined}>
            <FileText className="w-3.5 h-3.5" strokeWidth={1.75} /> Content
          </button>
          <button type="button" onClick={() => { setTab('diff'); loadDiff(); }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium mono ${tab === 'diff' ? 't-strong' : 'muted'}`}
            style={tab === 'diff' ? { borderBottom: '2px solid var(--accent)' } : undefined}>
            <GitCompare className="w-3.5 h-3.5" strokeWidth={1.75} /> Diff
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4" style={{ background: 'var(--bg)' }}>
          {loading ? (
            <div className="flex items-center gap-2 muted text-[12px]"><Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> Loading…</div>
          ) : err ? (
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{err}</p>
          ) : tab === 'content' ? (
            <>
              {truncated && <p className="text-[11px] muted mono mb-2">Preview truncated (first 20k chars).</p>}
              <pre className="mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px' }}>{content ?? ''}</pre>
            </>
          ) : diff === null ? (
            <div className="flex items-center gap-2 muted text-[12px]"><Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> Loading diff…</div>
          ) : !diff || !diff.trim() ? (
            <p className="text-[12px] muted">{diffDirty === false ? 'No changes vs HEAD.' : 'No diff available.'}</p>
          ) : (
            <pre className="mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px' }}>{diff}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
