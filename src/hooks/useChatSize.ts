// Shared size state for the floating chat windows (task chat + board
// assistant). Both panels are bottom-anchored on the right, so the left edge
// handle changes the width and the bottom edge handle changes the height.
// Size is persisted so a reload keeps the user's chosen geometry.

import { useCallback, useEffect, useRef, useState } from 'react';

export const CHAT_WIDTH_KEY = 'kanban_chat_width';
export const CHAT_HEIGHT_KEY = 'kanban_chat_height';

export const CHAT_MIN_WIDTH = 320;
export const CHAT_MIN_HEIGHT = 320;

/** Gap kept between the panel and the viewport edge on every side. */
export const CHAT_EDGE_GAP = 12;

export type ResizeAxis = 'x' | 'y' | 'xy';

const readNumber = (key: string): number | null => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
};

const writeNumber = (key: string, value: number) => {
  try { localStorage.setItem(key, String(Math.round(value))); } catch { /* private mode */ }
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const maxChatWidth = () => Math.max(CHAT_MIN_WIDTH, window.innerWidth - CHAT_EDGE_GAP * 2);
export const maxChatHeight = () => Math.max(CHAT_MIN_HEIGHT, window.innerHeight - CHAT_EDGE_GAP * 2);

const initialWidth = (fallback: number) => clamp(readNumber(CHAT_WIDTH_KEY) ?? fallback, CHAT_MIN_WIDTH, maxChatWidth());
const initialHeight = () => clamp(readNumber(CHAT_HEIGHT_KEY) ?? (window.innerHeight - CHAT_EDGE_GAP * 2), CHAT_MIN_HEIGHT, maxChatHeight());

export function useChatSize(defaultWidth = 448) {
  const [width, setWidth] = useState(() => initialWidth(defaultWidth));
  const [height, setHeight] = useState(() => initialHeight());
  // Latest geometry for the pointer-up persist, without re-binding listeners.
  const sizeRef = useRef({ width, height });
  useEffect(() => { sizeRef.current = { width, height }; }, [width, height]);

  const persist = useCallback(() => {
    writeNumber(CHAT_WIDTH_KEY, sizeRef.current.width);
    writeNumber(CHAT_HEIGHT_KEY, sizeRef.current.height);
  }, []);

  /** Back to the default panel: a readable width, full available height. */
  const reset = useCallback(() => {
    setWidth(clamp(defaultWidth, CHAT_MIN_WIDTH, maxChatWidth()));
    setHeight(maxChatHeight());
    requestAnimationFrame(persist);
  }, [defaultWidth, persist]);

  // A viewport shrink must not leave the panel larger than the screen.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => (w > maxChatWidth() ? maxChatWidth() : w));
      setHeight((h) => (h > maxChatHeight() ? maxChatHeight() : h));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * Begin a resize drag. `axis` picks which edge the pointer grabbed:
   * 'x' = left edge (width), 'y' = bottom edge (height), 'xy' = corner.
   * The panel is right/bottom anchored, so the pointer moves left to grow.
   */
  const startResize = useCallback((axis: ResizeAxis) => (e: React.PointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = sizeRef.current.width;
    const startH = sizeRef.current.height;
    // The panel is translated by the drag-to-move offset; ignore it here so
    // a resize started from a moved panel stays stable.
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const dy = startY - ev.clientY;
      if (dx || dy) moved = true;
      if (axis === 'x' || axis === 'xy') setWidth(clamp(startW + dx, CHAT_MIN_WIDTH, maxChatWidth()));
      if (axis === 'y' || axis === 'xy') setHeight(clamp(startH + dy, CHAT_MIN_HEIGHT, maxChatHeight()));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) requestAnimationFrame(persist);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [persist]);

  return { width, height, setWidth, setHeight, persist, reset, startResize };
}
