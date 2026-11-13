"use client";

import { Children, cloneElement, createContext, isValidElement, useContext, useMemo, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { useHomeDir } from "@/lib/home-dir";
import { remarkTextLinks } from "@/lib/remark-text-links";
import { expandHomePath, matchWholeTextLink } from "@/lib/text-links";
import { getFileApiUrl, markdownFileUrlTransform } from "@/lib/file-urls";
import { GithubRepoContext, remarkGithubRefs } from "../lib/github-refs";
import { normalizeDisplayMath, useMarkdownPlugins, type MarkdownPlugins } from "../lib/markdown";
import { markdownCodeRenderer } from "./MarkdownCode";
import { ClickableImage } from "./ImageLightbox";
import { openExternalUrl } from "./TextLink";

export const FileSessionContext = createContext<string | undefined>(undefined);

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  sourceSessionId?: string;
  onOpenFile?: (filePath: string) => void;
  suppressImages?: boolean;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, sourceSessionId, suppressImages = false }: MarkdownBodyProps) {
  const inheritedSessionId = useContext(FileSessionContext);
  const fileSessionId = sourceSessionId ?? inheritedSessionId;
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const { remarkPlugins: baseRemarkPlugins, rehypePlugins } = useMarkdownPlugins(normalizedMarkdown);
  const githubRepo = useContext(GithubRepoContext);
  const home = useHomeDir();
  const remarkPlugins = useMemo<MarkdownPlugins["remarkPlugins"]>(
    () => [...baseRemarkPlugins, remarkTextLinks, [remarkGithubRefs, { repo: githubRepo }]],
    [baseRemarkPlugins, githubRepo],
  );

  // Rebuilt only when its captured props change, not on every render.
  const components = useMemo<Components>(() => {
    const imgComponent = ({ src, alt, ...imgProps }: ComponentProps<"img"> & { node?: unknown }) => {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete (imgProps as { node?: unknown }).node;
      if (suppressImages) return alt ?? null;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? getFileApiUrl(filePath, "read", fileSessionId)
        : src;
      // Dynamic local paths are served directly by the file API.
      return <ClickableImage src={imageSrc} alt={alt ?? ""} loading="lazy" {...imgProps} />;
    };

    /**
     * Split link children into linked text and previewable images. Images may
     * sit directly or wrapped in formatting (`[**![img](x)**](url)`); a
     * <button> can never nest inside an <a>, so image content is extracted
     * while text (with its formatting) stays linked.
     */
    const isElementWithChildren = (value: unknown): value is ReactElement<{ children?: ReactNode }> => isValidElement(value);
    const partitionLinkContent = (node: ReactNode): { textParts: ReactNode[]; imageParts: ReactNode[] } => {
      const textParts: ReactNode[] = [];
      const imageParts: ReactNode[] = [];
      for (const child of Children.toArray(node)) {
        if (!isElementWithChildren(child)) {
          textParts.push(child);
          continue;
        }
        if (child.type === imgComponent) {
          imageParts.push(child);
          continue;
        }
        const sub = partitionLinkContent(child.props.children);
        if (sub.imageParts.length === 0) {
          textParts.push(child);
        } else if (sub.textParts.length === 0) {
          // Formatting wrapper containing only images moves to the previews.
          imageParts.push(child);
        } else {
          // Mixed wrapper: keep the wrapper with its text, extract the images.
          textParts.push(cloneElement(child, undefined, sub.textParts));
          imageParts.push(...sub.imageParts);
        }
      }
      return { textParts, imageParts };
    };
    /** True when any text part carries non-whitespace content. */
    const hasMeaningfulText = (parts: ReactNode[]): boolean =>
      parts.some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "number") return true;
        if (isElementWithChildren(part)) return hasMeaningfulText(Children.toArray(part.props.children));
        return false;
      });

    return {
    code: markdownCodeRenderer({
      isStreaming,
      inlineClassName: "markdown-inline-code",
      // A span that is one path or URL opens on click (double-click still selects it).
      inlineLink: (text) => {
        const link = matchWholeTextLink(text);
        if (!link) return null;
        if (link.kind === "url") return { open: () => openExternalUrl(link.value), title: link.value };
        const expanded = expandHomePath(link.value, home);
        const filePath = expanded && onOpenFile ? resolveLocalFileHref(expanded, cwd) : null;
        return filePath && onOpenFile ? { open: () => onOpenFile(filePath), title: filePath } : null;
      },
    }),
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const { textParts, imageParts } = partitionLinkContent(children);
      // A <button> cannot nest inside an <a>. Pure image links (direct or
      // wrapped in formatting, possibly with surrounding whitespace) render
      // only the previews — the lightbox supersedes the link. Mixed links
      // keep their text linked and render image previews beside the anchor.
      if (imageParts.length > 0 && !hasMeaningfulText(textParts)) {
        return <>{children}</>;
      }
      const localHref = href === "~" || href?.startsWith("~/") ? expandHomePath(href, home) : href;
      const filePath = localHref ? resolveLocalFileHref(localHref, cwd) : null;
      const openFile = onOpenFile;
      // A path detected in prose (remarkTextLinks) that this view cannot open stays text.
      if ((props as Record<string, unknown>)["data-text-link"] === "path" && !(filePath && openFile)) return <>{children}</>;
      if (filePath && openFile) {
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const target = event.currentTarget.getAttribute("target");
          if (target && target !== "_self") return;
          event.preventDefault();
          openFile(filePath);
        };
        const anchor = <a href={getFileApiUrl(filePath, "read", fileSessionId)} {...props} onClick={handleClick}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }

      const anchor = (
        <a href={filePath ? getFileApiUrl(filePath, "read", fileSessionId) : href} {...props} target="_blank" rel="noopener noreferrer">
          {textParts}
        </a>
      );
      return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
    },
    img: imgComponent,
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    };
  }, [isStreaming, cwd, onOpenFile, suppressImages, fileSessionId, home]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownFileUrlTransform}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
