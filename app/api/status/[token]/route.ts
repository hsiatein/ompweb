import { NextResponse } from "next/server";
import { readTextWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { StatusInputError, updateStatusItemsByToken } from "@/lib/status-board";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

// POST /api/status/<token> — a program updates its session's status board
// items. Body, JSON or YAML: one item, a list, or {items: [...]}; each item
// {id, title?, value?, max?, unit?, detail?, state?, kind?, blocks?} or
// {id, remove: true}. `blocks` is rich content (lib/status-board-blocks.ts).
// The token (one per session, from the status_board agent tool) is the only
// credential: proxy.ts lets exactly this path past the password and origin checks.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let text: string;
  try {
    text = await readTextWithinLimit(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Body is too large", code: "request_too_large" }, { status: 413 });
    }
    throw error;
  }
  try {
    const count = updateStatusItemsByToken(token, text);
    if (count === null) return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, updated: count });
  } catch (error) {
    if (error instanceof StatusInputError) {
      return NextResponse.json({ error: error.message, code: "invalid_status_item" }, { status: 400 });
    }
    throw error;
  }
}
