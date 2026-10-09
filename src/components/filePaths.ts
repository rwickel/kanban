// Detect absolute file paths inside chat markdown and turn them into
// clickable file-preview links. Windows-heavy (C:\... / C:/...) but also
// matches /unix/abs/paths with an extension.
// Rendered as [raw](file-preview:<encoded>) so SessionChatWindow can
// intercept the <a> click and open FilePreviewModal instead of navigating.

const WIN_PATH_RE =
  /([A-Za-z]:[\\/][^\s"'`<>|()\[\]{}]*\.[A-Za-z0-9]{1,8})/g;
const UNIX_PATH_RE =
  /(\/[^\s"'`<>|()\[\]{}]*\/[^\s"'`<>|()\[\]{}]+\.[A-Za-z0-9]{1,8})/g;

const TRAIL = /[.,;:!?)\]}>'"]+$/;

function linkifyWith(re: RegExp, md: string): string {
  return md.replace(re, (raw) => {
    const m = raw.match(TRAIL);
    const trail = m ? m[0] : '';
    const clean = trail ? raw.slice(0, -trail.length) : raw;
    if (!clean) return raw;
    return `[${clean}](file-preview:${encodeURIComponent(clean)})${trail}`;
  });
}

/** Convert raw chat markdown → markdown with file-preview links. Idempotent-ish. */
export function linkifyFilePaths(md: string): string {
  if (!md || md.includes('file-preview:')) return md;
  let out = linkifyWith(WIN_PATH_RE, md);
  out = linkifyWith(UNIX_PATH_RE, out);
  return out;
}

/** href produced by linkifyFilePaths → the original absolute path, or null. */
export function parsePreviewHref(href?: string): string | null {
  if (!href || !href.startsWith('file-preview:')) return null;
  try {
    return decodeURIComponent(href.slice('file-preview:'.length));
  } catch {
    return null;
  }
}
