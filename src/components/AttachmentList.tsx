import { useEffect, useRef, useState } from 'react';
import { Paperclip, X, Download, Loader2 } from 'lucide-react';
import { Attachment, removeAttachment, uploadAttachment, validateAttachment } from '../attachments';

export default function AttachmentList({ ownerType, ownerId, disabled = false }: { ownerType: 'task' | 'chat'; ownerId?: string; disabled?: boolean }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    if (!ownerId) { setItems([]); return; }
    fetch(`/api/kanban/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}`)
      .then(async (response) => { if (!response.ok) throw new Error('Could not load attachments.'); return response.json(); })
      .then((rows: Attachment[]) => { if (active) setItems(rows.map((item) => ({ ...item, url: `/api/kanban/attachments/${item.id}/content` }))); })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [ownerType, ownerId]);
  const addFiles = async (files: FileList | null) => {
    if (!files || !ownerId) return;
    setError(''); setBusy(true);
    try {
      const uploaded: Attachment[] = [];
      for (const file of Array.from(files)) {
        const problem = validateAttachment(file);
        if (problem) throw new Error(`${file.name}: ${problem}`);
        uploaded.push(await uploadAttachment(file, ownerType, ownerId));
      }
      setItems((current) => [...current, ...uploaded]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const remove = async (id: string) => {
    setError('');
    try { await removeAttachment(id); setItems((current) => current.filter((item) => item.id !== id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove attachment.'); }
  };
  return <section className="mt-2 space-y-1" aria-label="Attachments">
    {items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded border hairline p-1.5 text-xs">
      {item.type.startsWith('image/') ? <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={item.name} className="h-12 w-12 rounded object-cover" /></a> : <Paperclip className="h-4 w-4 shrink-0" />}
      <a className="min-w-0 flex-1 truncate underline" href={`/api/kanban/attachments/${item.id}/download`}>{item.name}</a>
      <a className="btn p-1" href={`/api/kanban/attachments/${item.id}/download`} title="Download"><Download className="h-3.5 w-3.5" /></a>
      <button type="button" className="btn p-1" onClick={() => void remove(item.id)} aria-label={`Remove ${item.name}`}><X className="h-3.5 w-3.5" /></button>
    </div>)}
    {ownerId && <div className="flex items-center gap-2"><input ref={input} type="file" multiple className="hidden" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,application/json,application/zip" onChange={(e) => void addFiles(e.target.files)} />
      <button type="button" className="btn px-2 py-1 text-xs" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : <Paperclip className="mr-1 inline h-3.5 w-3.5" />}Attach file</button><span className="text-[10px] muted">Images and documents · max 10 MB</span>
    </div>}
    {error && <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>{error}</p>}
  </section>;
}
