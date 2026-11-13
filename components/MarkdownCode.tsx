import type { HTMLAttributes, MouseEvent } from "react";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { TextLink } from "./TextLink";

/**
 * Double- and triple-click inside inline code select the whole span (a path,
 * command or identifier) instead of one word of it or the surrounding
 * paragraph. A single click and drag selection keep their native behavior.
 */
function selectInlineCodeOnMultiClick(event: MouseEvent<HTMLElement>): void {
  if (event.detail < 2 || event.button !== 0 || event.shiftKey) return;
  // Links inside the span keep the browser's own handling.
  const link = (event.target as Element).closest?.("a");
  if (link && event.currentTarget.contains(link)) return;
  const selection = window.getSelection();
  if (!selection) return;
  event.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(event.currentTarget);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Build the `code` renderer shared by MarkdownBody and FileViewer's
 * ReactMarkdown configs (the two previously inlined near-identical copies).
 *
 * `inlineClassName` pins inline code to a surface style (MarkdownBody's
 * "markdown-inline-code"); when omitted the incoming className is passed
 * through (FileViewer). `defaultPreview`/`isStreaming` thread the mermaid
 * and code-block props each host needs. `inlineLink` maps an inline span's
 * text to an opener when the whole span is a path or URL. */
export function markdownCodeRenderer(options: {
  isStreaming?: boolean;
  defaultPreview?: boolean;
  inlineClassName?: string;
  inlineLink?: (text: string) => { open: () => void; title: string } | null;
}) {
  return function Code({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
    const lang = className?.replace("language-", "").toLowerCase() ?? "";
    const raw = String(children);
    const isBlock = className?.includes("language-") || raw.includes("\n");
    if (isBlock) {
      if (lang === "mermaid") {
        return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={options.isStreaming} defaultPreview={options.defaultPreview} />;
      }
      return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={options.isStreaming} />;
    }
    const multiClick = (event: MouseEvent<HTMLElement>) => {
      props.onMouseDown?.(event);
      if (!event.defaultPrevented) selectInlineCodeOnMultiClick(event);
    };
    const link = options.inlineLink?.(raw) ?? null;
    if (link) {
      return (
        <TextLink as="code" className={options.inlineClassName ?? className} title={link.title} onOpen={link.open} onMouseDown={multiClick}>
          {children}
        </TextLink>
      );
    }
    return (
      <code className={options.inlineClassName ?? className} {...props} onMouseDown={multiClick}>
        {children}
      </code>
    );
  };
}
