import { Fragment, useMemo, type ReactNode } from "react";
import { resolveLocalFileHref } from "@/lib/file-links";
import { useHomeDir } from "@/lib/home-dir";
import { expandHomePath, findTextLinks } from "@/lib/text-links";
import { openExternalUrl, TextLink } from "./TextLink";

/** Longer text renders as is: scanning and splitting it costs more than the links are worth. */
const MAX_LINKIFY_CHARS = 512 * 1024;

/**
 * Plain text (tool output) with detected URLs and local paths clickable
 * (lib/text-links.ts). Paths open in the file viewer through `onOpenFile`;
 * without it, or when a path cannot be resolved, they stay text.
 */
export function LinkifiedText({ text, cwd, onOpenFile }: { text: string; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const home = useHomeDir();
  return useMemo(() => {
    if (text.length > MAX_LINKIFY_CHARS) return <>{text}</>;
    const parts: ReactNode[] = [];
    let last = 0;
    for (const link of findTextLinks(text)) {
      let open: (() => void) | null = null;
      let title = link.value;
      if (link.kind === "url") {
        open = () => openExternalUrl(link.value);
      } else if (onOpenFile) {
        const expanded = expandHomePath(link.value, home);
        const filePath = expanded ? resolveLocalFileHref(expanded, cwd) : null;
        if (filePath) {
          open = () => onOpenFile(filePath);
          title = filePath;
        }
      }
      if (!open) continue;
      if (link.start > last) parts.push(text.slice(last, link.start));
      parts.push(<TextLink key={link.start} title={title} onOpen={open}>{link.value}</TextLink>);
      last = link.end;
    }
    if (parts.length === 0) return <>{text}</>;
    parts.push(text.slice(last));
    return <Fragment>{parts}</Fragment>;
  }, [text, cwd, onOpenFile, home]);
}
