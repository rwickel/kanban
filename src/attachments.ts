export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
}

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
  'text/plain', 'text/markdown', 'application/json', 'application/zip',
]);

export function validateAttachment(file: Pick<File, 'type' | 'size' | 'name'>): string | null {
  if (file.size > MAX_ATTACHMENT_SIZE) return 'Files must be 10 MB or smaller.';
  const type = file.type || (file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : '');
  if (!ALLOWED_TYPES.has(type)) return 'This file type is not supported.';
  return null;
}

export async function uploadAttachment(file: File, ownerType: 'task' | 'chat', ownerId: string): Promise<Attachment> {
  const error = validateAttachment(file);
  if (error) throw new Error(error);
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`/api/kanban/attachments?ownerType=${ownerType}&ownerId=${encodeURIComponent(ownerId)}`, {
    method: 'POST', body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Upload failed.');
  return result as Attachment;
}

export async function removeAttachment(id: string): Promise<void> {
  const response = await fetch(`/api/kanban/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Could not remove attachment.');
}
