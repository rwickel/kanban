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

// Internal links never show the full address in the chat: the label is the
// basename (last segment). The full path stays in the href and title.
function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const name = path.slice(i + 1);
  return name || path;
}

function linkifyWith(re: RegExp, md: string): string {
  return md.replace(re, (raw) => {
    const m = raw.match(TRAIL);
    const trail = m ? m[0] : '';
    const clean = trail ? raw.slice(0, -trail.length) : raw;
    if (!clean) return raw;
    return `[${basenameOf(clean)}](file-preview:${encodeURIComponent(clean)})${trail}`;
  });
}

// Existing markdown link [text](url) — the URL part must stay untouched,
// otherwise the path regexes eat the URL and the link renders with an
// empty href (the file-preview: scheme is stripped by react-markdown's
// default urlTransform).
const MD_LINK_RE = /\[[^\]]*\]\([^()\s]+\)/g;

/**
 * Convert raw chat markdown → markdown with file-preview links.
 * Idempotent-ish: skips text that already carries a file-preview href.
 */
export function linkifyFilePaths(md: string): string {
  if (!md || md.includes('file-preview:')) return md;
  // Only linkify plain text; pass any existing [text](url) links through
  // unchanged so external links keep their href.
  let out = '';
  let last = 0;
  for (const m of md.matchAll(MD_LINK_RE)) {
    out += linkifyPlain(md.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += linkifyPlain(md.slice(last));
  return out;
}

function linkifyPlain(plain: string): string {
  return linkifyWith(UNIX_PATH_RE, linkifyWith(WIN_PATH_RE, plain));
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
