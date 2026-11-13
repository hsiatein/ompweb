import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { AgentInstructionValidationError, parseAgentInstructionRule, parseAgentInstructionTarget } from "@/lib/agent-instructions";
import { loadAgentInstructions, saveAgentInstruction } from "@/lib/agent-instructions-store";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) return apiErrorResponse(error, 413);
  if (error instanceof AgentInstructionValidationError || error instanceof SyntaxError) return apiErrorResponse(error, 400);
  return apiErrorResponse(error);
}

export async function GET() {
  try { return NextResponse.json({ rules: loadAgentInstructions() }); }
  catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const rule = parseAgentInstructionRule(await parseJsonWithinLimit(request, 128 * 1024));
    return NextResponse.json({ rules: saveAgentInstruction(rule, rule.text, rule.combine ?? "replace") });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const target = parseAgentInstructionTarget(await parseJsonWithinLimit(request, 4 * 1024));
    return NextResponse.json({ rules: saveAgentInstruction(target, null) });
  } catch (error) { return errorResponse(error); }
}
