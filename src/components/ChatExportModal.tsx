import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, X } from 'lucide-react';

export default function ChatExportModal({ title, content, fileName, onClose }: {
  title: string;
  content: string;
  fileName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be unavailable */ }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-stretch justify-stretch pointer-events-auto" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,.55)' }}>
      <section role="dialog" aria-modal="true" aria-labelledby="chat-export-title" className="panel flex h-full w-full flex-col overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <header className="modal-head flex items-center justify-between gap-3 px-4 py-3">
          <h2 id="chat-export-title" className="text-sm font-semibold t-strong">{title}</h2>
          <div className="flex gap-1.5">
            <button type="button" className="btn flex items-center gap-1.5 px-2 py-1.5 text-xs" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="btn flex items-center gap-1.5 px-2 py-1.5 text-xs" onClick={download}><Download size={14} />Download</button>
            <button type="button" className="btn p-1.5" onClick={onClose} aria-label="Close"><X size={15} /></button>
          </div>
        </header>
        <div className="m-3 flex-1 overflow-y-auto panel p-3" style={{ background: 'var(--bg)', border: '1px solid var(--border)', minHeight: 260 }}>
          <div className="md-body text-[14px] leading-relaxed break-words" style={{ color: 'var(--text)' }}>
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        </div>
      </section>
    </div>
  );
}
