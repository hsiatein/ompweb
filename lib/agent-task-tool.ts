import { registerServerHostTool } from "./rpc-manager";
import {
  cancelAgentTask,
  createAgentTask,
  DEFAULT_AGENT_WEBHOOK_HOURS,
  listAgentTasks,
  MAX_AGENT_TASKS_PER_SESSION,
  MAX_AGENT_WEBHOOK_HOURS,
  type ScheduledTaskView,
} from "./scheduled-tasks";
import { DEFAULT_WEBHOOK_LISTEN_PORT, MIN_INTERVAL_MINUTES } from "./schedule-recurrence";
import { isRecord } from "./type-guards";
import { listNetworkInterfaces } from "./webhook-listeners";

/**
 * `scheduled_tasks`: lets the agent schedule messages to ITS OWN session —
 * a one-time wake-up webhook (start a long job, have it POST the URL when it
 * finishes, end the turn) or a timed/recurring reminder. Answered by the
 * omp-web server, so it works with no browser tab open. Tasks show up in the
 * scheduled tasks window marked as agent-created.
 */
export const AGENT_TASK_TOOL_NAME = "scheduled_tasks";

const MAX_IN_MINUTES = 366 * 24 * 60;

/** The address the agent's own commands reach this server on (same host). */
export function localServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = env.OMP_WEB_PORT ?? env.PORT ?? "30177";
  let host = env.OMP_WEB_HOSTNAME?.trim() || "127.0.0.1";
  // Wildcard binds accept loopback; "localhost" may resolve to ::1 first.
  if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "localhost") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "server local time";
}

function formatServerTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The tool's trigger arguments as a ScheduleRepeat-shaped object. */
function repeatFromArgs(args: Record<string, unknown>, now: number): unknown {
  switch (args.trigger) {
    case "webhook":
      return { kind: "webhook" };
    case "once": {
      if (typeof args.inMinutes === "number") {
        if (!Number.isFinite(args.inMinutes) || args.inMinutes < 0 || args.inMinutes > MAX_IN_MINUTES) {
          throw new Error(`inMinutes must be from 0 to ${MAX_IN_MINUTES}`);
        }
        return { kind: "once", at: now + args.inMinutes * 60_000 };
      }
      const at = typeof args.at === "string" ? Date.parse(args.at) : Number.NaN;
      if (!Number.isFinite(at)) throw new Error("A once trigger needs inMinutes, or at as an ISO 8601 date-time");
      return { kind: "once", at };
    }
    case "interval":
      return { kind: "interval", minutes: args.everyMinutes };
    case "daily":
      return { kind: "daily", time: args.time };
    case "weekly":
      return { kind: "weekly", days: args.days, time: args.time };
    default:
      throw new Error("trigger must be webhook, once, interval, daily or weekly");
  }
}

/** `listenInterfaces`/`listenPort` as a webhookListen value (undefined: omp-web's own URL). */
function listenFromArgs(args: Record<string, unknown>): unknown {
  if (args.listenInterfaces === undefined) {
    if (args.listenPort !== undefined) throw new Error("listenPort needs listenInterfaces");
    return undefined;
  }
  return { interfaces: args.listenInterfaces, port: args.listenPort ?? DEFAULT_WEBHOOK_LISTEN_PORT };
}

function describeInterfaces(): string {
  const lines = listNetworkInterfaces().map((entry) => `  ${entry.name}: ${entry.addresses.join(", ")}`);
  return ["Network interfaces (for listenInterfaces):", ...lines].join("\n");
}

function describeTask(task: ScheduledTaskView): string {
  const repeat = task.repeat;
  const when = repeat.kind === "webhook"
    ? `webhook${task.expiresAt ? `, expires ${formatServerTime(task.expiresAt)}` : ""}`
    : repeat.kind === "once"
      ? `once at ${formatServerTime(repeat.at)}`
      : repeat.kind === "interval"
        ? `every ${repeat.minutes} min`
        : repeat.kind === "daily"
          ? `daily at ${repeat.time}`
          : `weekly on days ${repeat.days.join(",")} at ${repeat.time}`;
  const next = task.nextRunAt !== null ? `; next ${formatServerTime(task.nextRunAt)}` : "";
  return `- ${task.id} "${task.name}": ${when}${next}${task.enabled ? "" : " (paused)"}`;
}

function webhookInstructions(urls: string[], dedicated: boolean): string {
  const url = urls[0];
  return [
    dedicated
      ? `Webhook URL (one use; only on the chosen interfaces and port):\n${urls.map((entry) => `  ${entry}`).join("\n")}`
      : `Webhook URL (one use; works from this machine): ${url}`,
    "POST to it once when the job ends; the request body (up to 16,000 chars) is appended to your message.",
    "Report success and failure alike, e.g. in tmux:",
    `  tmux new -d -s job 'long_command > job.log 2>&1; code=$?; { echo "exit=$code"; tail -n 40 job.log; } | curl -s -X POST --data-binary @- "${url}"'`,
    "After the first call the URL stops working. You can end your turn now; the message arrives in this session (queued if you are busy).",
  ].join("\n");
}

/** The dedicated listener binds asynchronously; give it a moment so bind errors can be reported. */
const BIND_SETTLE_MS = 300;

async function run(caller: { sessionId: string }, args: Record<string, unknown>): Promise<string> {
  const now = Date.now();
  switch (args.action) {
    case "create": {
      const created = await createAgentTask(caller.sessionId, {
        name: args.name,
        message: args.message,
        repeat: repeatFromArgs(args, now),
        expiresInHours: args.expiresInHours,
        webhookListen: listenFromArgs(args),
      }, now);
      let task = created;
      if (created.webhookListen) {
        await new Promise((resolve) => setTimeout(resolve, BIND_SETTLE_MS));
        task = listAgentTasks(caller.sessionId).find((entry) => entry.id === created.id) ?? created;
      }
      const lines = [`Created scheduled task ${task.id}.`, describeTask(task)];
      if (task.webhookToken && task.webhookEndpoints) {
        const urls = task.webhookEndpoints.filter((entry) => entry.url && !entry.error).map((entry) => entry.url!);
        const problems = task.webhookEndpoints.filter((entry) => entry.error)
          .map((entry) => `  ${entry.iface}${entry.address ? ` ${entry.address}` : ""}: ${entry.error === "interface_down" ? "no address yet (bound once it gets one)" : `not listening (${entry.error})`}`);
        if (urls.length > 0) lines.push(webhookInstructions(urls, true));
        else lines.push("No URL is reachable yet.");
        if (problems.length > 0) lines.push("Not listening on:", ...problems);
      } else if (task.webhookToken) {
        lines.push(webhookInstructions([`${localServerUrl()}/api/hooks/${task.webhookToken}`], false));
      }
      return lines.join("\n");
    }
    case "list": {
      const tasks = listAgentTasks(caller.sessionId);
      const header = `Server time: ${formatServerTime(now)} (${serverTimeZone()}).`;
      if (tasks.length === 0) return `${header}\nThis session has no scheduled tasks.\n${describeInterfaces()}`;
      return [header, ...tasks.map(describeTask), describeInterfaces()].join("\n");
    }
    case "cancel": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) throw new Error("cancel needs the task id");
      if (!cancelAgentTask(caller.sessionId, id)) throw new Error(`No scheduled task ${id} of this session`);
      return `Cancelled ${id}.`;
    }
    default:
      throw new Error("action must be create, list or cancel");
  }
}

registerServerHostTool({
  definition: {
    name: AGENT_TASK_TOOL_NAME,
    description: [
      // omp lists plugin tools by the first line of the description, cut to
      // 200 bytes, so that line must name every capability on its own.
      "Message THIS session later, even after your turn ends: a one-time wake-up webhook (omp-web URL, or listenInterfaces for LAN/WireGuard/other hosts) or once/interval/daily/weekly timers.",
      "Delivered by omp-web; queued as a follow-up if you are busy then.",
      "Use trigger \"webhook\" to wait for a long job: get a one-time URL, start the job (e.g. in tmux) so that it POSTs the URL when it finishes, then end your turn instead of polling; the POST body is appended to the message.",
      "By default the URL is omp-web's own (reachable from this machine). For a caller elsewhere (another host on the LAN, over WireGuard), set listenInterfaces (interface names; list shows them with their addresses) and optionally listenPort: the URL then works only on those interfaces' addresses at that port.",
      "Use once/interval/daily/weekly for timed check-ins.",
      `Times are the omp-web server's local time (${serverTimeZone()}); prefer inMinutes for once.`,
      `At most ${MAX_AGENT_TASKS_PER_SESSION} tasks per session; webhook URLs expire unused after ${DEFAULT_AGENT_WEBHOOK_HOURS} h by default (max ${MAX_AGENT_WEBHOOK_HOURS} h).`,
      "One-time tasks (webhook, once) disappear after delivering. list shows this session's tasks and the network interfaces; cancel removes one.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "cancel"] },
        name: { type: "string", description: "create: short label shown to the user." },
        message: { type: "string", description: "create: the message you will receive, e.g. what to check and how." },
        trigger: { type: "string", enum: ["webhook", "once", "interval", "daily", "weekly"], description: "create: when the message is sent." },
        inMinutes: { type: "number", description: "once: minutes from now." },
        at: { type: "string", description: "once: ISO 8601 date-time (alternative to inMinutes)." },
        everyMinutes: { type: "number", description: `interval: minutes between messages (at least ${MIN_INTERVAL_MINUTES}).` },
        time: { type: "string", description: "daily/weekly: HH:MM, server local time." },
        days: { type: "array", items: { type: "number" }, description: "weekly: 0=Sunday … 6=Saturday." },
        expiresInHours: { type: "number", description: "webhook: delete the URL if unused after this long." },
        listenInterfaces: { type: "array", items: { type: "string" }, description: "webhook: network interface names (e.g. lo, enp5s0, wg0) to listen on instead of omp-web's own address; see list." },
        listenPort: { type: "number", description: `webhook with listenInterfaces: port (default ${DEFAULT_WEBHOOK_LISTEN_PORT}).` },
        id: { type: "string", description: "cancel: task id from create or list." },
      },
      required: ["action"],
    },
  },
  run: (caller, args) => run(caller, isRecord(args) ? args : {}),
});
