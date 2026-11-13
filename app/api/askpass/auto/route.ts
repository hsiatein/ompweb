import { NextResponse } from "next/server";
import { askpassAutoEnabled, askpassSupported, setAskpassAuto } from "@/lib/askpass";

const MAX_PASSWORD_CHARS = 1024;

// GET /api/askpass/auto → { supported, enabled }
export function GET() {
  return NextResponse.json({ supported: askpassSupported(), enabled: askpassAutoEnabled() });
}

// PUT /api/askpass/auto  body: { enabled: true, password } | { enabled: false }
// Turning it on verifies the password with sudo first. The password stays in
// server memory until it is turned off or the server restarts; it is never
// returned, written or logged.
export async function PUT(req: Request) {
  let body: { enabled?: unknown; password?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (body.enabled === false) {
    await setAskpassAuto(null);
    return NextResponse.json({ enabled: false });
  }
  if (body.enabled !== true) {
    return NextResponse.json({ error: "enabled must be a boolean", code: "invalid_request" }, { status: 400 });
  }
  if (!askpassSupported()) {
    return NextResponse.json({ error: "sudo prompts are not available on this server", code: "askpass_unsupported" }, { status: 409 });
  }
  const password = body.password;
  if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_CHARS || /[\r\n\0]/.test(password)) {
    return NextResponse.json({ error: "Invalid password", code: "askpass_invalid_password" }, { status: 400 });
  }
  if (!(await setAskpassAuto(password))) {
    return NextResponse.json({ error: "Incorrect sudo password", code: "askpass_wrong_password" }, { status: 403 });
  }
  return NextResponse.json({ enabled: true });
}
