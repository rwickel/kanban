import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_SIZE, validateAttachment } from './attachments.ts';

test('attachment validation accepts images and supported documents', () => {
  assert.equal(validateAttachment({ type: 'image/png', size: 10, name: 'a.png' }), null);
  assert.equal(validateAttachment({ type: 'application/pdf', size: 10, name: 'a.pdf' }), null);
});

test('attachment validation rejects oversized and unsupported files', () => {
  assert.match(validateAttachment({ type: 'image/png', size: MAX_ATTACHMENT_SIZE + 1, name: 'a.png' }) || '', /10 MB/);
  assert.match(validateAttachment({ type: 'application/x-msdownload', size: 10, name: 'a.exe' }) || '', /not supported/);
});
