import { listMemos } from "./memo-store";
import type { Memo } from "./memos";
import { registerServerHostTool } from "./rpc-manager";
import { isRecord } from "./type-guards";

/**
 * `memos`: read-only access to the user's omp-web memos (web-memos.json) for
 * every agent session. Answered by the omp-web server; the agent can list,
 * search and read memos but never create, edit or delete them.
 */
export const AGENT_MEMO_TOOL_NAME = "memos";

const PREVIEW_CHARS = 160;
const MAX_RESULTS = 50;

function title(memo: Memo): string {
  return memo.title.trim() || "(untitled)";
}

function summary(memo: Memo): string {
  const preview = memo.content.replace(/\s+/g, " ").trim();
  const clipped = preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS)}…` : preview;
  return `- ${memo.id}${memo.pinned ? " [pinned]" : ""} ${JSON.stringify(title(memo))} (updated ${memo.updatedAt}, ${memo.content.length} chars)${clipped ? `\n  ${clipped}` : ""}`;
}

export async function runMemoTool(args: Record<string, unknown>): Promise<string> {
  const memos = await listMemos();
  switch (args.action ?? "list") {
    case "list":
    case "search": {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      if (args.action === "search" && !query) throw new Error("search needs a query");
      const matches = query
        ? memos.filter((memo) => memo.title.toLowerCase().includes(query) || memo.content.toLowerCase().includes(query))
        : memos;
      if (matches.length === 0) return query ? `No memo matches ${JSON.stringify(query)}.` : "The user has no memos.";
      const shown = matches.slice(0, MAX_RESULTS);
      const more = matches.length > shown.length ? `\n… ${matches.length - shown.length} more; narrow the search.` : "";
      return `${matches.length} memo(s)${query ? ` matching ${JSON.stringify(query)}` : ""}, pinned first then most recently updated:\n${shown.map(summary).join("\n")}${more}`;
    }
    case "read": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) throw new Error("read needs a memo id from list or search");
      const memo = memos.find((item) => item.id === id);
      if (!memo) throw new Error(`No memo ${id}`);
      return `# ${title(memo)}\n(id ${memo.id}${memo.pinned ? ", pinned" : ""}, created ${memo.createdAt}, updated ${memo.updatedAt})\n\n${memo.content}`;
    }
    default:
      throw new Error("action must be list, search or read");
  }
}

registerServerHostTool({
  definition: {
    name: AGENT_MEMO_TOOL_NAME,
    description: [
      "Read the user's omp-web memos (personal notes kept in the omp-web Memos window). Read-only: you cannot create, edit or delete memos.",
      "list shows every memo with a short preview; search finds memos whose title or text contains a phrase (case-insensitive); read returns one memo's full Markdown text by id.",
      "Use it when the user refers to their memos/notes or when a memo is likely to hold what you need.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "search", "read"] },
        query: { type: "string", description: "search: phrase to look for in titles and text." },
        id: { type: "string", description: "read: memo id from list or search." },
      },
      required: ["action"],
    },
  },
  run: (_caller, args) => runMemoTool(isRecord(args) ? args : {}),
});
