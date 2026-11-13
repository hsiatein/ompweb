import type { AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * Reply text and images written before the final answer of a turn (the notes an agent
 * leaves between tool calls), in order. Thinking, tool calls and empty text are left
 * out: they stay inside the collapsed process details.
 */
export function interimAnswerBlocks(
  messages: ReadonlyArray<{ role: string }>,
  processIndices: readonly number[],
  finalProcessBlocks: readonly AssistantContentBlock[],
): AssistantContentBlock[] {
  const keep = (block: AssistantContentBlock) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0);
  const blocks: AssistantContentBlock[] = [];
  for (const index of processIndices) {
    const message = messages[index];
    if (message?.role === "assistant") blocks.push(...((message as AssistantMessage).content ?? []).filter(keep));
  }
  blocks.push(...finalProcessBlocks.filter(keep));
  return blocks;
}
