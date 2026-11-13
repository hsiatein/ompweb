import { NextResponse } from "next/server";
import { syncInterruptibleSessions } from "@/lib/rpc-manager";
import { loadWebServerSettings, saveWebServerSettings } from "@/lib/web-settings";

export const dynamic = "force-dynamic";

// GET/PUT /api/web-settings - omp-web's own server-side settings.
export async function GET() {
  return NextResponse.json(loadWebServerSettings());
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const input = body as { autoResumeSessions?: unknown; subagentsEnabled?: unknown } | null;
  const autoResumeSessions = input?.autoResumeSessions;
  const subagentsEnabled = input?.subagentsEnabled;
  if (
    !input || typeof input !== "object" || Array.isArray(input)
    || (autoResumeSessions === undefined && subagentsEnabled === undefined)
    || (autoResumeSessions !== undefined && typeof autoResumeSessions !== "boolean")
    || (subagentsEnabled !== undefined && typeof subagentsEnabled !== "boolean")
  ) {
    return NextResponse.json({ error: "Provide boolean autoResumeSessions or subagentsEnabled", code: "invalid_settings" }, { status: 400 });
  }
  const settings = saveWebServerSettings({
    ...(typeof autoResumeSessions === "boolean" ? { autoResumeSessions } : {}),
    ...(typeof subagentsEnabled === "boolean" ? { subagentsEnabled } : {}),
  });
  if (autoResumeSessions !== undefined) syncInterruptibleSessions();
  return NextResponse.json(settings);
}
