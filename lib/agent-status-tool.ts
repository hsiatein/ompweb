import { localServerUrl } from "./agent-task-tool";
import { getRpcSession, registerServerHostTool } from "./rpc-manager";
import {
  listStatusItems,
  MAX_ITEMS_PER_SESSION,
  parseStatusDocument,
  removeStatusItems,
  statusTokenFor,
  updateStatusItems,
} from "./status-board";
import type { StatusItem } from "./status-board-types";
import { isRecord } from "./type-guards";

/**
 * `status_board`: the calling session's items on the user's status board
 * (right panel, Status tab). The agent and the programs it starts describe
 * items; the board lays them out. Always acts on the CALLING session — the id
 * comes from the RPC wrapper, never from tool arguments.
 */
export const AGENT_STATUS_TOOL_NAME = "status_board";

const ITEM_FIELDS = ["id", "title", "kind", "state", "value", "max", "unit", "detail", "blocks", "remove"] as const;

/** Shared by the tool schema and the push-URL help. */
const BLOCKS_HELP = [
  "blocks: rich content under the item, a list (replaces the previous list; null clears). Block forms:",
  "  \"any markdown string\" or {type: markdown, text}",
  "  {type: kv, title?, entries: {label: value, ...} or [{label, value, unit?, state?}]}",
  "  {type: table, title?, columns: [..], rows: [[..], ..]}  (or rows as objects; columns then come from their keys)",
  "  {type: progress, label, value, max, unit?, state?}  (sub-progress bar)",
  "  {type: chart, title?, chart: line|bar, xLabel?, yLabel?, series: {name: [y, ..] or [[x, y], ..]} or [{name, points}]}",
  "  {type: code, title?, text}  (monospace, e.g. a log tail)",
  "Limits: 20 blocks, 200 table rows, 12 columns, 6 series x 500 points, 48 KiB per item.",
].join("\n");

function identityOf(sessionId: string, cwd: string): { sessionName?: string; cwd: string } {
  const sessionName = getRpcSession(sessionId)?.askpassIdentity().sessionName;
  return { ...(sessionName ? { sessionName } : {}), cwd };
}

function describe(item: StatusItem): string {
  const amount = item.kind === "progress" && item.value !== undefined && item.max !== undefined
    ? ` ${item.value}/${item.max}${item.unit ? ` ${item.unit}` : ""}`
    : item.value !== undefined ? ` ${item.value}${item.unit ? ` ${item.unit}` : ""}` : "";
  const blocks = item.blocks?.length ? ` (+${item.blocks.length} block(s): ${item.blocks.map((block) => block.type).join(", ")})` : "";
  return `- ${item.id} [${item.kind}, ${item.state}] ${JSON.stringify(item.title)}${amount}${item.detail ? ` — ${item.detail}` : ""}${blocks}`;
}

function endpointHelp(url: string): string {
  return [
    `Push URL for this session (secret; keep it out of logs and chat): ${url}`,
    "POST JSON or YAML (any Content-Type): one item, a list, or {\"items\": [...]}. Item fields: id (required), title, value, max, unit, detail, state (running|paused|done|failed|info), kind (progress|value|text; inferred), blocks, or {\"id\": ..., \"remove\": true}.",
    BLOCKS_HELP,
    "Send only what changed; omitted fields keep their values. A progress item reaching max turns done by itself.",
    "Python (stdlib, ignores proxy settings):",
    "  import json, urllib.request",
    `  _opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))`,
    "  def status(**item):",
    "      try:",
    `          _opener.open(urllib.request.Request(${JSON.stringify(url)}, json.dumps(item).encode(), {"Content-Type": "application/json"}), timeout=5)`,
    "      except Exception:",
    "          pass  # the board is best-effort; never let it stop the job",
    "  status(id=\"train\", title=\"Training\", value=step, max=total_steps, detail=f\"loss {loss:.4f}\")",
    "Shell:",
    `  curl -s --noproxy '*' -X POST -H 'Content-Type: application/json' -d '{"id":"job","title":"Build","state":"running"}' '${url}'`,
    `  curl -s --noproxy '*' -X POST -H 'Content-Type: application/yaml' --data-binary @status.yaml '${url}'`,
    "The URL works where omp-web is reachable (it answers on this machine). For a job on another host, push from this machine (e.g. a loop reading its log over ssh).",
  ].join("\n");
}

async function run(caller: { sessionId: string; cwd: string }, args: Record<string, unknown>): Promise<string> {
  if (!caller.sessionId) throw new Error("This session has no id yet; send a message first");
  const identity = identityOf(caller.sessionId, caller.cwd);
  switch (args.action) {
    case "set": {
      let items: unknown;
      if (typeof args.document === "string") items = parseStatusDocument(args.document);
      else if (Array.isArray(args.items)) items = args.items;
      else {
        const single: Record<string, unknown> = {};
        for (const field of ITEM_FIELDS) if (args[field] !== undefined) single[field] = args[field];
        items = [single];
      }
      const count = updateStatusItems(caller.sessionId, items, identity);
      return `Updated ${count} item(s) on the status board.`;
    }
    case "remove": {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string")
        : typeof args.id === "string" ? [args.id] : [];
      if (ids.length === 0) throw new Error("remove needs id or ids");
      return `Removed ${removeStatusItems(caller.sessionId, ids)} item(s).`;
    }
    case "clear":
      return `Removed ${removeStatusItems(caller.sessionId)} item(s).`;
    case "list": {
      const items = listStatusItems(caller.sessionId);
      return items.length === 0 ? "This session has no status items." : items.map(describe).join("\n");
    }
    case "endpoint":
      return endpointHelp(`${localServerUrl()}/api/status/${statusTokenFor(caller.sessionId, identity)}`);
    default:
      throw new Error("action must be set, remove, clear, list or endpoint");
  }
}

const itemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable key (letters, digits, _ . : -); setting it again updates the item." },
    title: { type: "string" },
    kind: { type: "string", enum: ["progress", "value", "text"], description: "progress = value/max bar with rate and ETA; value = a metric with a sparkline; text = a note. Inferred when omitted." },
    state: { type: "string", enum: ["running", "paused", "done", "failed", "info"] },
    value: { type: "number" },
    max: { type: "number", description: "progress: total." },
    unit: { type: "string", description: "e.g. steps, epochs, %, GB" },
    detail: { type: "string", description: "One line: current phase, last metric, error message." },
    blocks: { type: "array", items: { type: "object" }, description: BLOCKS_HELP },
    remove: { type: "boolean" },
  },
  required: ["id"],
};

registerServerHostTool({
  definition: {
    name: AGENT_STATUS_TOOL_NAME,
    description: [
      // omp lists plugin tools by the first line of the description, cut to
      // 200 bytes, so that line must name every capability on its own.
      "Show live status for THIS session on the user's omp-web status board (progress bars, metrics, notes); programs you start can push updates over HTTP (action endpoint).",
      "Use it for anything the user may want to watch without reading the chat: training/eval progress, long jobs, experiment metrics, a short current-phase note.",
      "set creates or updates items (one item via the fields below, several via items, or document: the same update written as a JSON or YAML string); only send what changed. remove/clear delete items; list shows them.",
      "Beyond one-line detail, an item can carry blocks: markdown, key/value lists, tables, sub-progress bars, line/bar charts and code/log text (see the blocks field).",
      "endpoint returns this session's secret push URL with Python and curl snippets, so a script can report progress itself while you end your turn.",
      `The board decides the layout; mark items done/failed when they finish (finished items disappear after a day). At most ${MAX_ITEMS_PER_SESSION} items per session.`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "remove", "clear", "list", "endpoint"] },
        items: { type: "array", items: itemSchema, description: "set: several items at once." },
        document: { type: "string", description: "set: the update as JSON or YAML text (one item, a list, or {items: [...]}); use instead of the other fields." },
        ...itemSchema.properties,
        id: { type: "string", description: "set/remove: item key." },
        ids: { type: "array", items: { type: "string" }, description: "remove: several keys." },
      },
      required: ["action"],
    },
  },
  run: (caller, args) => run(caller, isRecord(args) ? args : {}),
});
