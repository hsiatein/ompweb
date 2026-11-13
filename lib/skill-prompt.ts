/**
 * omp records a user's `/skill:<name> <args>` message as a `skill-prompt`
 * custom message (the expanded SKILL.md body as content, the typed line in
 * `details.prompt`), not as a user message. These helpers recover what the
 * user typed so the chat, the session list and naming treat it as their message.
 */

export const SKILL_PROMPT_CUSTOM_TYPE = "skill-prompt";

/** The line the user typed for a skill invocation, or null when `details` is not one. */
export function skillPromptUserText(customType: unknown, details: unknown, attribution?: unknown): string | null {
  if (customType !== SKILL_PROMPT_CUSTOM_TYPE || attribution === "agent") return null;
  if (!details || typeof details !== "object") return null;
  const { prompt, name, args } = details as { prompt?: unknown; name?: unknown; args?: unknown };
  if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  if (typeof name !== "string" || !name) return null;
  return `/skill:${name}${typeof args === "string" && args.trim() ? ` ${args.trim()}` : ""}`;
}
