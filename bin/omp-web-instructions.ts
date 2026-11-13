import { loadAgentInstructions } from "../lib/agent-instructions-store";
import { agentInstructionTexts } from "../lib/agent-instructions";

// Runs inside OMP, not Next. Keep this structural boundary free of Bun-only SDK imports.
interface InstructionExtensionAPI {
  on(event: "before_agent_start", handler: (
    event: { systemPrompt: string[] },
    ctx: { model?: { provider: string; id: string } },
  ) => { systemPrompt: string[] } | undefined): void;
}

export default function agentInstructions(api: InstructionExtensionAPI): void {
  api.on("before_agent_start", (event, ctx) => {
    const rules = loadAgentInstructions(process.env.OMP_WEB_AGENT_INSTRUCTIONS_FILE);
    const texts = agentInstructionTexts(rules, ctx.model?.provider, ctx.model?.id);
    if (texts.length === 0) return;
    // OMP supplies the base anew for each prompt/dequeued user batch. Never reuse a
    // previous override or replace native instructions, project context, or sudo policy.
    return { systemPrompt: [...event.systemPrompt, ...texts] };
  });
}
