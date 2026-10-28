import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkifyFilePaths, parsePreviewHref } from './filePaths.ts';

describe('linkifyFilePaths', () => {
  it('keeps external markdown link URLs untouched', () => {
    const md = '- [NH-U14S TR4-SP3-Kühler](https://www.ebay.de/itm/336826979558) — not for AM4.';
    assert.equal(linkifyFilePaths(md), md);
  });

  it('keeps external URLs with query strings untouched', () => {
    const md = '- [search](https://www.ebay.de/sch/i.html?_nkw=AM4+CPU)';
    assert.equal(linkifyFilePaths(md), md);
  });

  it('does not turn a plain repository URL into a file-preview link', () => {
    const md = 'https://github.com/rwickel/kanban.git';
    assert.equal(linkifyFilePaths(md), md);
  });

  it('converts plain Windows paths to file-preview links with a filename label', () => {
    const out = linkifyFilePaths('plain C:\\Users\\rober\\work\\kanban\\utf8.txt in text');
    assert.match(out, /\[utf8\.txt\]\(file-preview:[^)]+\)/);
    assert.ok(!out.includes('[C:\\Users\\rober\\work\\kanban\\utf8.txt]'), 'full path never used as label');
  });

  it('converts plain Unix paths to file-preview links with a filename label', () => {
    const out = linkifyFilePaths('see /home/rober/work/kanban/utf8.txt now');
    assert.match(out, /\[utf8\.txt\]\(file-preview:[^)]+\)/);
    assert.ok(!out.includes('[/home/rober/work/kanban/utf8.txt]'), 'full path never used as label');
  });

  it('keeps the full path in the encoded href', () => {
    const out = linkifyFilePaths('plain C:\\Users\\rober\\work\\kanban\\utf8.txt in text');
    assert.ok(out.includes('file-preview:' + encodeURIComponent('C:\\Users\\rober\\work\\kanban\\utf8.txt')));
  });

  it('mixes external links and plain paths in one message', () => {
    const md = 'mix [ebay](https://www.ebay.de) and C:\\Users\\rober\\work\\kanban\\utf8.txt end';
    const out = linkifyFilePaths(md);
    assert.ok(out.includes('[ebay](https://www.ebay.de)'), 'external link kept');
    assert.match(out, /\[utf8\.txt\]\(file-preview:[^)]+\)/);
  });

  it('keeps a plain URL intact while linking a nearby Windows path', () => {
    const url = 'https://github.com/rwickel/kanban.git';
    const out = linkifyFilePaths(`${url} C:\\Users\\rober\\work\\kanban\\README.md`);
    assert.ok(out.startsWith(url), 'URL is unchanged');
    assert.match(out, /\[README\.md\]\(file-preview:[^)]+\)/);
  });

  it('leaves an already file-preview link untouched', () => {
    const md = '- [file](file-preview:C%3A%5CUsers%5Cutf8)';
    assert.equal(linkifyFilePaths(md), md);
  });

  it('is idempotent on plain paths', () => {
    const once = linkifyFilePaths('see C:\\Users\\rober\\utf8.txt now');
    assert.equal(linkifyFilePaths(once), once);
  });
});

describe('parsePreviewHref', () => {
  it('decodes a file-preview href back to the absolute path', () => {
    assert.equal(parsePreviewHref('file-preview:C%3A%5CUsers%5Cutf8'), 'C:\\Users\\utf8');
  });

  it('returns null for non file-preview hrefs', () => {
    assert.equal(parsePreviewHref('https://www.ebay.de/itm/123'), null);
    assert.equal(parsePreviewHref(undefined), null);
  });
});
