import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { readAgentModelOverrides, setAgentModelOverride } from "@/lib/omp/agent-model-overrides";

export const dynamic = "force-dynamic";

// omp `task.agentModelOverrides` (lib/omp/agent-model-overrides.ts).
// GET → {overrides}; PUT {agent, model: string | null} updates one agent.
export function GET() {
  try {
    return NextResponse.json({ overrides: readAgentModelOverrides() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await parseJsonWithinLimit<{ agent?: unknown; model?: unknown }>(request, 4 * 1024);
    if (typeof body.agent !== "string") return NextResponse.json({ error: "agent must be a string" }, { status: 400 });
    if (body.model !== null && typeof body.model !== "string") return NextResponse.json({ error: "model must be a string or null" }, { status: 400 });
    return NextResponse.json({ overrides: setAgentModelOverride(body.agent, body.model) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
