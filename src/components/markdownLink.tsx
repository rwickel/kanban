// Shared external-link renderer for chat and board markdown.
// Every external <a> must open in a new browser tab so a plain link can
// never replace the kanban app window (same-tab navigation).

import type { ReactNode } from 'react';

export function externalLink(href: string | undefined, children: ReactNode) {
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}
