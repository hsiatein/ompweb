import { NextResponse } from "next/server";
import { clearFinishedStatusItems, getStatusBoardSnapshot, removeStatusItems } from "@/lib/status-board";

export const dynamic = "force-dynamic";

// GET /api/status-board — every session's status items (the Status tab also
// receives them live as `status_board` frames on /api/events).
export function GET() {
  return NextResponse.json(getStatusBoardSnapshot());
}

// DELETE /api/status-board?sessionId=…&id=… removes one item;
// ?sessionId=…&finished=1 removes the session's done/failed items;
// ?sessionId=… alone removes all of them.
export function DELETE(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId is required", code: "invalid_request" }, { status: 400 });
  const id = url.searchParams.get("id");
  const removed = url.searchParams.get("finished") === "1"
    ? clearFinishedStatusItems(sessionId)
    : removeStatusItems(sessionId, id ? [id] : undefined);
  return NextResponse.json({ removed });
}
