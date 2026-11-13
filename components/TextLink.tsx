import { createElement, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

/** How long a click waits for a second one before it opens (double-click selects instead). */
const OPEN_DELAY_MS = 260;

/**
 * Text that opens something on click (a detected path or URL in inline code
 * or tool output) while staying ordinary selectable text: a single click
 * opens after a short pause, a double/triple click or a drag selects as
 * usual, and Enter opens it from the keyboard. Not an <a>, because the
 * browser drags links instead of selecting their text.
 */
export function TextLink({ as = "span", className, title, onOpen, onMouseDown, children }: {
  as?: "span" | "code";
  className?: string;
  title?: string;
  onOpen: () => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(onOpen);
  useEffect(() => { openRef.current = onOpen; }, [onOpen]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return createElement(as, {
    className: className ? `${className} text-link` : "text-link",
    role: "link",
    tabIndex: 0,
    title,
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (event.detail > 1) cancel();
      onMouseDown?.(event);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey) return;
      // A drag that ended here selected text: keep the selection, open nothing.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
      cancel();
      timer.current = setTimeout(() => { timer.current = null; openRef.current(); }, OPEN_DELAY_MS);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      openRef.current();
    },
  }, children);
}

export function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
