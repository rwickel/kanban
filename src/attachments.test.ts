import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_SIZE, validateAttachment, attachmentsToOpenCodeFiles, attachmentExtension } from './attachments.ts';

test('attachments become OpenCode file inputs', () => {
  assert.deepEqual(attachmentsToOpenCodeFiles([{ id: '1', name: 'note.txt', type: 'text/plain', size: 4, url: '', uri: 'file:///tmp/note.txt' }]), [{ uri: 'file:///tmp/note.txt', name: 'note.txt' }]);
  assert.deepEqual(attachmentsToOpenCodeFiles([{ id: '2', name: 'no-uri', type: 'text/plain', size: 0, url: '' }]), []);
});

test('attachment file name without an extension is supported', () => {
  assert.equal(attachmentExtension('README'), '');
  assert.equal(attachmentExtension('note.TXT'), 'txt');
  assert.equal(attachmentExtension('long.abcdefghijk'), '');
});

test('attachment validation accepts images and supported documents', () => {
  assert.equal(validateAttachment({ type: 'image/png', size: 10, name: 'a.png' }), null);
  assert.equal(validateAttachment({ type: 'application/pdf', size: 10, name: 'a.pdf' }), null);
});

test('attachment validation rejects oversized and unsupported files', () => {
  assert.match(validateAttachment({ type: 'image/png', size: MAX_ATTACHMENT_SIZE + 1, name: 'a.png' }) || '', /10 MB/);
  assert.match(validateAttachment({ type: 'application/x-msdownload', size: 10, name: 'a.exe' }) || '', /not supported/);
});
