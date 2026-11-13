import { subscribeAskpassRequests } from "@/lib/askpass";
import { subscribeStatusBoard } from "@/lib/status-board";
import { getAttentionItems, getExitedRpcSessions, getRunningRpcSessions, getSubagentSessions, subscribeHostToolCalls, subscribeRunningSessions } from "@/lib/rpc-manager";
import { subscribeSessionFileChanges } from "@/lib/session-watcher";

export const dynamic = "force-dynamic";

// GET /api/events - the page-wide SSE stream every omp-web tab holds once
// (client: lib/app-events.ts). Browsers allow six HTTP/1.1 connections per
// host; one shared stream instead of one per feature leaves room for the chat
// stream, file watches, the terminal and ordinary requests. Frames:
// - running: running session ids, exited sessions, pending "needs you"
//   dialogs, and refresh hints for the session list;
// - sessions-changed: a live session's file metadata changed;
// - askpass_requests: pending sudo password requests (never passwords). While
//   no tab holds this stream, requests are refused at once;
// - host_tool_call: host tool calls (open_url, notify, open_file) from sessions
//   no tab is watching;
// - status_board: every session's status board items (snapshot).
export async function GET(req: Request) {
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the subscribers.
  let streamCleanup: (() => void) | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const unsubscribers: Array<() => void> = [];
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer ?? undefined);
        heartbeatTimer = null;
        for (const unsubscribe of unsubscribers.splice(0)) {
          try { unsubscribe(); } catch {}
        }
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const encode = (data: unknown) => send(`data: ${JSON.stringify(data)}\n\n`);

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      // Subscribe BEFORE taking the initial running snapshot so no state
      // change can slip through the gap between snapshot and subscription.
      unsubscribers.push(subscribeRunningSessions(({ ids, runningSessions, subagentSessions, exitedSessions, attention, refreshSessionList }) => {
        encode({
          type: "running",
          runningSessionIds: ids,
          runningSessions,
          subagentSessions,
          exitedSessions,
          attention,
          ...(refreshSessionList ? { refreshSessionList: true } : {}),
        });
      }));
      unsubscribers.push(subscribeSessionFileChanges((sessionIds) => {
        encode({ type: "sessions-changed", sessionIds, refreshSessionList: true });
      }));
      const initialRunning = getRunningRpcSessions();
      encode({
        type: "running",
        runningSessionIds: initialRunning.map((s) => s.id),
        runningSessions: initialRunning,
        subagentSessions: getSubagentSessions(),
        attention: getAttentionItems(),
        exitedSessions: getExitedRpcSessions(),
      });
      // Delivers the current pending list immediately.
      unsubscribers.push(subscribeAskpassRequests((requests) => {
        encode({ type: "askpass_requests", requests });
      }));
      unsubscribers.push(subscribeHostToolCalls((call) => {
        encode({ type: "host_tool_call", ...call });
      }));
      // Delivers the current board immediately, then each (coalesced) change.
      unsubscribers.push(subscribeStatusBoard((snapshot) => {
        encode({ type: "status_board", ...snapshot });
      }));
      // Heartbeat to keep the connection alive through proxies/timeouts.
      heartbeatTimer = setInterval(() => send(":\n\n"), 30_000);
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
