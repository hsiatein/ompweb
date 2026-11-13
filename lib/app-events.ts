/**
 * Client side of /api/events: one EventSource per page, shared by every
 * subscriber (sidebar running state, sudo prompts, cross-session host tools).
 * Browsers allow six HTTP/1.1 connections per host, so each feature opening
 * its own stream starved ordinary requests such as the session list.
 */

export type AppEventFrame = Record<string, unknown> & { type?: string };

export interface AppEventListener {
  /** Every parsed frame; listeners pick the `type`s they handle. */
  onFrame: (frame: AppEventFrame) => void;
  /** The connection dropped; EventSource reconnects by itself. */
  onError?: () => void;
}

/** Frames that carry a full state snapshot: a listener that subscribes after
 * the stream opened gets the latest one at once instead of waiting for the
 * next change. Other frames are one-off events and are not replayed. */
const SNAPSHOT_TYPES = new Set(["running", "askpass_requests", "status_board"]);

const listeners = new Set<AppEventListener>();
const latestSnapshots = new Map<string, AppEventFrame>();
let source: EventSource | null = null;

function open(): EventSource {
  const next = new EventSource("/api/events");
  next.onmessage = (event) => {
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return; // ignore malformed frames
    }
    if (!frame || typeof frame !== "object") return;
    const typed = frame as AppEventFrame;
    if (typed.type && SNAPSHOT_TYPES.has(typed.type)) latestSnapshots.set(typed.type, typed);
    for (const listener of [...listeners]) listener.onFrame(typed);
  };
  next.onerror = () => {
    for (const listener of [...listeners]) listener.onError?.();
  };
  return next;
}

/** Listen to the page-wide stream; the connection closes with the last listener. */
export function subscribeAppEvents(listener: AppEventListener): () => void {
  listeners.add(listener);
  if (source) {
    for (const frame of latestSnapshots.values()) listener.onFrame(frame);
  } else {
    source = open();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
      latestSnapshots.clear();
    }
  };
}
