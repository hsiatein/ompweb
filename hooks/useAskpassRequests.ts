"use client";

import { useEffect, useState } from "react";
import { subscribeAppEvents } from "@/lib/app-events";
import type { AskpassRequestInfo } from "@/lib/askpass";

/** Pending sudo password requests (lib/askpass.ts), live from the page-wide /api/events stream. */
export function useAskpassRequests(): AskpassRequestInfo[] {
  const [requests, setRequests] = useState<AskpassRequestInfo[]>([]);
  useEffect(() => subscribeAppEvents({
    onFrame: (frame) => {
      if (frame.type === "askpass_requests" && Array.isArray(frame.requests)) setRequests(frame.requests as AskpassRequestInfo[]);
    },
  }), []);
  return requests;
}
