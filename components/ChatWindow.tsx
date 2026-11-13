"use client";
import { sendAgentCommand } from "@/lib/agent-client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { matchesShortcut } from "@/lib/keyboard-shortcuts";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Layers, Paperclip, Square } from "lucide-react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { translate, useI18n } from "@/lib/i18n";
import { getDisplayableAssistantBlocks, interimAnswerBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { isGroupAnchor, planTranscriptRows, type TranscriptRow } from "@/lib/chat-transcript-plan";
import { resolveForkEntryIds } from "@/lib/chat-fork";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ExtensionDialog } from "./ExtensionDialog";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ComposerPanels } from "./ComposerPanels";
import { WhaleTail } from "./WhaleTail";
import OmpWebLogo from "./OmpWebLogo";
import { CHAT_COLUMN_MAX_WIDTH, MINIMAP_WIDTH } from "@/lib/chat-layout";
import { collectGenerationSpeedSamples, GENERATION_SPEED_AVERAGE_WINDOW, summarizeGenerationSpeed } from "@/lib/generation-speed";
import { WorkspaceState } from "./AppShell-layout";
import { useAgentSession, type AgentPhase, type NoticeItem, type SubagentInfo } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useSpeechSynthesis, SpeechSynthesisProvider } from "@/hooks/useSpeechSynthesis";
import { GithubRepoContext } from "@/lib/github-refs";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScheduledMessages } from "@/hooks/useScheduledMessages";
import { useModalDialog } from "@/hooks/useModalDialog";
import type { SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { ProviderUsageContext } from "@/lib/provider-usage-types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { resolveAvailableThinkingLevels } from "@/lib/thinking-levels";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import {
  captureScrollDistance,
  getNextVisibleCount,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { getDraftSummary } from "@/lib/draft-store";
import { resolvePetState, type PetActivity } from "@/lib/pets";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  newSessionWorkspace?: ReactNode;
  toolCallsDefaultCollapsed?: boolean;
  onAgentEnd?: () => void;
  onPetActivityChange?: (activity: PetActivity) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onProviderUsageContextChange?: (context: ProviderUsageContext | null) => void;
  onOpenFile?: (filePath: string) => void;
  /** Handles the open_url host tool; returns the result text for the agent. */
  onOpenUrl?: (url: string) => string;
  onGenerationSpeedChange?: (speed: GenerationSpeedInfo | null) => void;
  /** Open Settings → Models & Providers (from the model picker). */
  onOpenProviders?: () => void;
}

function phaseLabel(phase: AgentPhase): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((tool) => tool.name);
    if (names.length === 0) return translate("chatWindow.runningTool");
    if (names.length <= 3) return translate("chatWindow.runningNamed", { names: names.join(", ") });
    return translate("chatWindow.runningNamedMore", { names: names.slice(0, 2).join(", "), more: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return translate("chatWindow.waitingModel");
  if (phase?.kind === "running_command") return translate("chatWindow.runningCommand");
  return translate("chatWindow.thinking");
}

const CHAT_COLUMN_PADDING = 16;
// Symmetric centering halves maxWidth reduction across both sides; compensate
// so the right clearance (padding + half-reduction) equals the minimap width.
const MINIMAP_CLEARANCE = 2 * (MINIMAP_WIDTH - CHAT_COLUMN_PADDING);
const CHAT_COLUMN_MAX_WIDTH_DESKTOP = `min(${CHAT_COLUMN_MAX_WIDTH}px, calc(100% - ${MINIMAP_CLEARANCE}px))`;
// Trigger the next history page while the sentinel is still this far below
// the top edge, so a normal upward scroll seamlessly continues into the newly
// loaded messages. Triggering only at the very top made the load invisible:
// the restore anchored the viewport to the old content, so the user parked on
// the banner and the load looked like a no-op.
const LOAD_MORE_ROOT_MARGIN = "400px 0px 0px 0px";

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Text of the newest assistant reply for read-aloud. The live streaming
 * message wins when present; otherwise the last committed assistant row is
 * used, keyed by its entry id so the row's own speaker button lights up.
 */
function assistantSpeech(
  messages: AgentMessage[],
  entryIds: string[],
  streaming: Partial<AgentMessage> | null,
): { id: string; text: string } | null {
  const textOf = (content: unknown): string => {
    if (!Array.isArray(content)) return "";
    return content
      .filter((block: unknown): block is { type: "text"; text: string } => {
        if (!block || typeof block !== "object") return false;
        if (!("type" in block) || block.type !== "text") return false;
        return "text" in block && typeof block.text === "string";
      })
      .map((block) => block.text)
      .join("\n\n");
  };

  if (streaming && streaming.role === "assistant") {
    const text = textOf(streaming.content);
    if (text.trim()) {
      return { id: streaming.timestamp ? String(streaming.timestamp) : "msg", text };
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (!text.trim()) break;
    return { id: entryIds[i] ?? (message.timestamp ? String(message.timestamp) : "msg"), text };
  }
  return null;
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

// Retain the last successful value across welcome-screen remounts, not reloads.
let lastKnownOmpVersion: string | undefined;

export function OmpRuntimeVersion() {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null | undefined>(lastKnownOmpVersion);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/omp-version")
      .then((res) => {
        if (!res.ok) throw new Error(`Version lookup failed: HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { version: string | null } | null) => {
        if (cancelled) return;
        // omp reports "omp/17.1.3"; show just the number next to the label.
        const nextVersion = typeof data?.version === "string" ? data.version.trim().replace(/^omp\//, "") : "";
        lastKnownOmpVersion = nextVersion || undefined;
        setVersion(nextVersion || null);
      })
      .catch(() => {
        if (cancelled) return;
        setVersion(lastKnownOmpVersion ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <span aria-busy={version === undefined} style={{ fontSize: 11, color: "var(--text-muted)" }}>
      omp <span style={{ color: "var(--text)" }}>{version === undefined ? t("appShell.loading") : version ? `v${version}` : t("chatWindow.versionNotFound")}</span>
    </span>
  );
}

/**
 * Collapsed tool calls and thinking of a finished turn. `collapsedContent` (the reply
 * text written between tool calls) shows only while collapsed; expanded, the same text
 * appears in place inside `children`.
 */
function ProcessDetailsGroup({ messageCount, toolCallCount, children, collapsedContent }: { messageCount: number; toolCallCount: number; children: () => ReactNode; collapsedContent?: () => ReactNode }) {
  const { t, tn } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chatWindow.processDetails"), tn("chatWindow.messageCount", messageCount)];
  if (toolCallCount > 0) parts.push(tn("chatWindow.toolCallCount", toolCallCount));

  return (
    <div style={{ marginBottom: 4 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="process-details-toggle"
        title={expanded ? t("chatWindow.collapseProcessDetails") : t("chatWindow.expandProcessDetails")}
      >
        <Layers
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--accent)" }}
        />
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
        <span className="process-details-label">
          {parts.join(" · ")}
        </span>
      </button>
      {expanded ? (
        <div style={{ marginTop: 3 }}>
          {children()}
        </div>
      ) : collapsedContent?.()}
    </div>
  );
}

function renderClusteredProcessMessages(
  messages: AgentMessage[],
  visibleProcessIndices: number[],
  finalAssistantIdx: number | null,
  finalProcessMessage: AssistantMessage | null,
  renderMessage: (idx: number, options?: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean }) => ReactNode,
): ReactNode[] {
  const rendered: ReactNode[] = [];
  let pendingToolCalls: Array<{ block: ToolCallContent; msgIdx: number }> = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    if (pendingToolCalls.length === 1) {
      const item = pendingToolCalls[0];
      const origMsg = messages[item.msgIdx] as AssistantMessage;
      if (origMsg.content?.length === 1) {
        rendered.push(renderMessage(item.msgIdx, { attachRef: false, keyPrefix: "process" }));
      } else {
        rendered.push(
          renderMessage(item.msgIdx, {
            attachRef: false,
            keyPrefix: `process-tool-${item.msgIdx}`,
            messageOverride: withAssistantBlocks(origMsg, [item.block], { omitUsage: true }),
            showTimestamp: false,
          }),
        );
      }
    } else {
      const first = pendingToolCalls[0];
      const baseMsg = messages[first.msgIdx] as AssistantMessage;
      const combinedMsg = withAssistantBlocks(
        baseMsg,
        pendingToolCalls.map((c) => c.block),
        { omitUsage: true },
      );
      rendered.push(
        renderMessage(first.msgIdx, {
          attachRef: false,
          keyPrefix: `process-cluster-${first.msgIdx}-${pendingToolCalls.length}`,
          messageOverride: combinedMsg,
          showTimestamp: false,
        }),
      );
    }
    pendingToolCalls = [];
  };

  for (const idx of visibleProcessIndices) {
    const msg = messages[idx];
    if (msg?.role === "assistant") {
      const blocks = getDisplayableAssistantBlocks(msg as AssistantMessage);
      for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
        const block = blocks[bIdx];
        if (block.type === "thinking") {
          flushToolCalls();
          const thinkingMsg = withAssistantBlocks(msg as AssistantMessage, [block], { omitUsage: true });
          rendered.push(
            renderMessage(idx, {
              attachRef: false,
              keyPrefix: `process-thinking-${idx}-${bIdx}`,
              messageOverride: thinkingMsg,
              showTimestamp: false,
            }),
          );
        } else if (block.type === "toolCall") {
          pendingToolCalls.push({ block: block as ToolCallContent, msgIdx: idx });
        } else {
          flushToolCalls();
          const otherMsg = withAssistantBlocks(msg as AssistantMessage, [block], { omitUsage: true });
          rendered.push(
            renderMessage(idx, {
              attachRef: false,
              keyPrefix: `process-block-${idx}-${bIdx}`,
              messageOverride: otherMsg,
              showTimestamp: false,
            }),
          );
        }
      }
    } else {
      flushToolCalls();
      rendered.push(renderMessage(idx, { attachRef: false, keyPrefix: "process" }));
    }
  }

  if (finalAssistantIdx !== null && finalProcessMessage) {
    const blocks = getDisplayableAssistantBlocks(finalProcessMessage);
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const block = blocks[bIdx];
      if (block.type === "thinking") {
        flushToolCalls();
        const thinkingMsg = withAssistantBlocks(finalProcessMessage, [block], { omitUsage: true });
        rendered.push(
          renderMessage(finalAssistantIdx, {
            attachRef: false,
            keyPrefix: `process-final-thinking-${finalAssistantIdx}-${bIdx}`,
            messageOverride: thinkingMsg,
            showTimestamp: false,
          }),
        );
      } else if (block.type === "toolCall") {
        pendingToolCalls.push({ block: block as ToolCallContent, msgIdx: finalAssistantIdx });
      } else {
        flushToolCalls();
        const otherMsg = withAssistantBlocks(finalProcessMessage, [block], { omitUsage: true });
        rendered.push(
          renderMessage(finalAssistantIdx, {
            attachRef: false,
            keyPrefix: `process-final-block-${finalAssistantIdx}-${bIdx}`,
            messageOverride: otherMsg,
            showTimestamp: false,
          }),
        );
      }
    }
  }

  flushToolCalls();
  return rendered;
}

interface CommittedTranscriptProps {
  messages: AgentMessage[];
  entryIds: string[];
  conversationMeta: { toolResultsMap: Map<string, ToolResultMessage>; lastAnchorIdx: number; visibleRefIndexByMessage: Map<number, number> };
  messageRefs: React.RefObject<(HTMLDivElement | null)[]>;
  isStreaming: boolean;
  sessionBusy: boolean;
  isNew: boolean;
  forkingEntryId: string | null;
  handleFork: (entryId: string) => void;
  /** Edit and resend a user message (branch off before it, text in the composer). */
  handleEditFromHere: (entryId: string, content: string) => void;
  modelNames: Record<string, string>;
  messageCwd: string | undefined;
  onOpenFile?: (filePath: string) => void;
  sessionId: string | undefined;
  toolCallsDefaultCollapsed: boolean;
  visibleCount: number;
  /** True while the viewport is near the bottom of the conversation. When
   *  false (user is reading history), the render window anchors its top so
   *  messages appended by a running agent cannot slide the viewed messages
   *  out of the window. */
  nearBottom: boolean;
  sentinelRef: React.RefObject<HTMLButtonElement | null>;
  handleLoadMoreClick: () => void;
  /** Receives how many rows the render window currently spans. */
  renderedRowCountRef: React.RefObject<number>;
}

/**
 * The committed (non-streaming) transcript. Extracted from ChatWindow and
 * memoized over the committed messages so token-streaming updates (which only
 * change `streamingMessage`, rendered separately) do not re-run the O(history)
 * grouping/splitting work at display-frame cadence.
 */
const CommittedTranscript = memo(function CommittedTranscript({
  messages, entryIds, conversationMeta, messageRefs, isStreaming, sessionBusy, isNew, forkingEntryId,
  handleFork, handleEditFromHere, modelNames, messageCwd, onOpenFile, sessionId,
  toolCallsDefaultCollapsed, visibleCount, nearBottom, sentinelRef, handleLoadMoreClick, renderedRowCountRef,
}: CommittedTranscriptProps) {
  const { t } = useI18n();
  const { toolResultsMap, lastAnchorIdx, visibleRefIndexByMessage } = conversationMeta;
  // omp's `branch` command accepts a user entry only, so every row forks at the
  // user prompt that started its turn (#103).
  const forkEntryIds = useMemo(
    () => resolveForkEntryIds(messages.map((message) => message.role), entryIds),
    [messages, entryIds],
  );

  const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
    messageRefs.current[refIndex] = el;
  };

  const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; noActions?: boolean } = {}): ReactNode => {
    const msg = options.messageOverride ?? messages[idx];
    const isVisible = msg.role === "user" || msg.role === "assistant";
    const currentRefIdx = visibleRefIndexByMessage.get(idx);
    const keyPrefix = options.keyPrefix ?? "message";
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const r = messages[j].role;
        if (r === "user") break;
        if (r === "assistant") { showTimestamp = false; break; }
      }
      // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
      if (showTimestamp && isStreaming && idx === messages.length - 1) {
        showTimestamp = false;
      }
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    // Forking needs a branch point omp accepts, and a first user prompt has no
    // earlier context to fork from — that one row keeps no fork action.
    // A merged view (interim notes of several messages) has no single entry to fork from.
    const canOfferFork = !options.noActions && !sessionBusy && !isNew && !!forkEntryIds[idx] && !(idx === 0 && msg.role === "user");
    const view = (
      <MessageView
        key={`${keyPrefix}-view-${idx}`}
        message={msg}
        toolResults={toolResultsMap}
        modelNames={modelNames}
        cwd={messageCwd}
        onOpenFile={onOpenFile}
        entryId={entryIds[idx]}
        forkEntryId={forkEntryIds[idx]}
        onFork={canOfferFork ? handleFork : undefined}
        forking={forkingEntryId === forkEntryIds[idx]}
        onEditFromHere={canOfferFork && msg.role === "user" ? handleEditFromHere : undefined}
        showTimestamp={showTimestamp}
        prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
        sessionId={sessionId}
        toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
      />
    );
    if (msg.role === "custom" && msg.customType === "compaction" && options.attachRef !== false) {
      // Anchor for keeping the reading position across the pre-compaction toggle.
      return <div key={`${keyPrefix}-${idx}`} data-entry-id={entryIds[idx]}>{view}</div>;
    }
    if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
    return (
      <div key={`${keyPrefix}-${idx}`} data-message-index={idx} data-entry-id={entryIds[idx]} ref={attachVisibleRef(idx, currentRefIdx)}>
        {view}
      </div>
    );
  };

  // Rows are plain descriptors; element creation below only happens for the
  // visible window. Invisible history never allocates React elements, so long
  // sessions pay element cost proportional to the visible window instead of
  // the whole transcript.
  const rows = useMemo<TranscriptRow[]>(() => planTranscriptRows(messages), [messages]);
  const isLiveTail = (row: TranscriptRow): boolean => {
    if (row.kind !== "group") return false;
    return (sessionBusy || isStreaming) && row.endIndex === messages.length && row.userIndex === lastAnchorIdx;
  };

  // Anchor the render window while the user is reading history: the plain
  // end-anchored window (total - visibleCount) slides forward as a running
  // agent appends messages, silently pushing the viewed messages out of the
  // window with no scroll correction. While not near the bottom, keep the
  // window's top at the last end-anchored position and let the appended tail
  // grow into the window; returning to the bottom re-engages the end anchor.
  const anchorStartIndexRef = useRef<number | null>(null);
  const windowFirstEntryRef = useRef<string | undefined>(undefined);
  const firstEntryId = entryIds[0];
  const { startIndex, hasMore } = useMemo(() => {
    const total = rows.length;
    const endAnchored = Math.max(0, total - visibleCount);
    // Another first entry means another history view (pre-compaction toggle,
    // compaction): the anchored row index no longer refers to the same rows.
    if (windowFirstEntryRef.current !== firstEntryId) {
      windowFirstEntryRef.current = firstEntryId;
      anchorStartIndexRef.current = null;
    }
    if (nearBottom || anchorStartIndexRef.current === null) {
      anchorStartIndexRef.current = endAnchored;
      renderedRowCountRef.current = total - endAnchored;
      return { startIndex: endAnchored, hasMore: endAnchored > 0 };
    }
    const anchored = Math.min(anchorStartIndexRef.current, endAnchored);
    anchorStartIndexRef.current = anchored;
    renderedRowCountRef.current = total - anchored;
    return { startIndex: anchored, hasMore: anchored > 0 };
  }, [rows.length, visibleCount, nearBottom, firstEntryId, renderedRowCountRef]);

  const rendered: ReactNode[] = [];
  for (let rowIdx = startIndex; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (row.kind === "message") {
      rendered.push(renderMessage(row.index));
      continue;
    }
    const { userIndex: userIdx, endIndex: endIdx, finalAssistantIndex: finalAssistantIdx, processIndices, processCount, toolCallCount: groupToolCallCount, hasFinalAnswer } = row;

    if (isLiveTail(row)) {
      // Live tail: the run may still be producing the final answer — flatten
      // the group so streaming updates render without a collapsed wrapper.
      for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
        rendered.push(renderMessage(renderIdx));
      }
      continue;
    }

    rendered.push(renderMessage(userIdx));
    const processRefIdx = processIndices
      .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
      .find((value): value is number => typeof value === "number")
      ?? (hasFinalAnswer ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
    const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const finalProcessMessage = finalSplit.processBlocks.length > 0
      ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
      : null;
    const finalAnswerMessage = hasFinalAnswer
      ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
      : null;
    const interimBlocks = interimAnswerBlocks(messages, processIndices, finalSplit.processBlocks);
    const interimSourceIdx = processIndices.find((processIdx) => messages[processIdx]?.role === "assistant") ?? finalAssistantIdx;
    const interimMessage = interimBlocks.length > 0
      ? withAssistantBlocks(messages[interimSourceIdx] as AssistantMessage, interimBlocks, { omitUsage: true })
      : null;

    if (processCount > 0) {
      const processGroup = (
        <ProcessDetailsGroup
          messageCount={processCount}
          toolCallCount={groupToolCallCount}
          collapsedContent={interimMessage
            ? () => renderMessage(interimSourceIdx, { messageOverride: interimMessage, attachRef: false, keyPrefix: "interim", showTimestamp: false, noActions: true })
            : undefined}
        >
          {() => renderClusteredProcessMessages(
            messages,
            processIndices,
            finalProcessMessage ? finalAssistantIdx : null,
            finalProcessMessage,
            renderMessage,
          )}
        </ProcessDetailsGroup>
      );
      rendered.push(
        <div
          key={`process-group-${userIdx}-${finalAssistantIdx}`}
          ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
        >
          {processGroup}
        </div>,
      );
    }

    if (finalAnswerMessage) {
      rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
    }
    for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
      rendered.push(renderMessage(renderIdx));
    }
  }
  return (
    <>
      {hasMore && (
        <button
          ref={sentinelRef}
          type="button"
          onClick={handleLoadMoreClick}
          className="py-3 w-full text-center text-xs text-text-muted hover:text-text transition-colors cursor-pointer"
        >
          {t("chatWindow.scrollUpToLoad", { count: startIndex })}
        </button>
      )}
      {rendered}
    </>
  );
});

export function ChatWindow({ session, newSessionCwd, newSessionWorkspace, toolCallsDefaultCollapsed = true, onAgentEnd, onPetActivityChange, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onProviderUsageContextChange, onGenerationSpeedChange, onOpenFile, onOpenUrl, onOpenProviders }: Props) {
  const { t, tn } = useI18n();
  const { playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render. playDoneSound
  // checks the sound preference itself.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const tts = useSpeechSynthesis();
  const ttsRef = useRef(tts);
  useEffect(() => {
    ttsRef.current = tts;
  }, [tts]);
  // omp calls onAgentEnd in the same tick as the state update that commits the
  // finished reply, so reading the transcript here would still see the previous
  // one. Flag it instead and speak from the render that carries it.
  const autoplayPendingRef = useRef(false);

  const wrappedOnAgentEnd = useCallback(() => {
    playDoneSoundRef.current();
    if (ttsRef.current.autoPlayEnabled) autoplayPendingRef.current = true;
    onAgentEnd?.();
  }, [onAgentEnd]);
  const {
    loading, error, messages, entryIds, showPreCompactionHistory, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelsLoading, modelError, modelThinkingLevels, modelThinkingLevelMaps, thinkingLevel, fastModeEnabled, fastModeActive,
    toolPreset,
    liveModelMeta,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactResult, tokensPerSecond, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, advisorActive, advisorEnabled, handleAdvisorChange,
    notices, dismissNotice, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase, activeGoal, activePlan,
    liveToolResults,
    subagents, subagentEvents, subagentTranscriptVersions, activeSubagentCount, currentTodoPhase, todoPhases,
    isNew,
    pendingAccountPins, setPendingAccountPins,
    pendingProviderPin, setPendingProviderPin,
    routingSessionId, routingInitializing,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    handleSend, handleAbort, handleFork, handleEditFromHere, handleModelChange, retrySession,
    handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction, handleCompact,
    removeQueuedMessage, promoteQueuedToSteer,
    handleBuiltinSlashCommand, togglePreCompactionHistory,
    handleThinkingLevelChange, handleFastModeChange, handleCycleModel, handleCycleThinkingLevel, handleAbortRetry, loadSlashCommands,
    handleToolPresetChange,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen,
    onOpenFile, onOpenUrl,
  });
  useEffect(() => {
    if (!autoplayPendingRef.current) return;
    autoplayPendingRef.current = false;
    const speech = assistantSpeech(messages, entryIds, streamState.streamingMessage);
    if (speech) ttsRef.current.speak(speech.id, speech.text);
  }, [messages, entryIds, streamState, agentRunning]);
  const sessionBusy = agentRunning || bashRunning;
  const scheduled = useScheduledMessages(session?.id ?? null, advisorEnabled);
  const petSessionKey = session?.id ?? newSessionCwd ?? "";
  const lastAssistant = useMemo(() => messages.findLast((message) => message.role === "assistant") as AssistantMessage | undefined, [messages]);
  const petState = resolvePetState({
    waiting: Boolean(extensionDialog || extensionCustomUi),
    running: sessionBusy || isCompacting,
    failed: Boolean(error || notices.some((notice) => notice.type === "error") || lastAssistant?.stopReason === "error"),
    completed: Boolean(lastAssistant && lastAssistant.stopReason !== "aborted"),
  });
  useEffect(() => {
    onPetActivityChange?.({ sessionKey: petSessionKey, state: petState });
  }, [onPetActivityChange, petSessionKey, petState]);
  const modelCapacity = useMemo(() => {
    if (!displayModelValue) return null;
    const model = modelList.find((entry) => entry.provider === displayModelValue.provider && entry.id === displayModelValue.modelId);
    if (!model || (!model.contextWindow && !model.maxTokens)) return null;
    return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  }, [displayModelValue, modelList]);

  const providerUsageContext = useMemo<ProviderUsageContext | null>(
    () => displayModelValue ? { provider: displayModelValue.provider, modelId: displayModelValue.modelId } : null,
    // Deps are the primitive identity of the model — a new wrapper object
    // per streaming frame must not re-create the context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayModelValue?.provider, displayModelValue?.modelId],
  );
  useEffect(() => {
    onProviderUsageContextChange?.(providerUsageContext);
    return () => onProviderUsageContextChange?.(null);
  }, [onProviderUsageContextChange, providerUsageContext]);
  // Every number here is omp's own tok/s (output tokens / request duration):
  // `current` is the polled get_state.tokensPerSecond, and the history comes
  // from the committed messages' usage.output and duration, so the average
  // and the speed chart survive reloads with the same definition.
  const speedSamples = useMemo(() => collectGenerationSpeedSamples(messages), [messages]);
  const generationSpeed = useMemo<GenerationSpeedInfo | null>(() => {
    const current = tokensPerSecond !== null && Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
      ? Math.round(tokensPerSecond * 10) / 10
      : null;
    const average = summarizeGenerationSpeed(speedSamples.slice(-GENERATION_SPEED_AVERAGE_WINDOW))?.mean ?? null;
    if (current === null && average === null) return null;
    return { current, average, samples: speedSamples };
  }, [tokensPerSecond, speedSamples]);


  // Register the abort handler for the configurable global shortcut. The cleanup
  // matters: unmounting mid-run must not leave the module-global handler
  // pointing at this (now unmounted) instance's handleAbort.
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
    return () => registerAbortHandler(null);
  }, [sessionBusy, handleAbort]);

  // Cycle model / thinking level using the shared shortcut bindings.
  useEffect(() => {
    if (!session) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"], .settings-view, [data-native-context-menu]')) return;
      if (matchesShortcut("cycleModel", e)) {
        e.preventDefault();
        void handleCycleModel();
      } else if (matchesShortcut("cycleThinking", e)) {
        e.preventDefault();
        void handleCycleThinkingLevel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session, handleCycleModel, handleCycleThinkingLevel]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const prevSessionKeyForPagingRef = useRef<string | null>(null);
  const sessionKeyForPaging = session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : "empty");
  useEffect(() => {
    if (prevSessionKeyForPagingRef.current !== sessionKeyForPaging) {
      prevSessionKeyForPagingRef.current = sessionKeyForPaging;
      setVisibleCount(VISIBLE_PAGE_SIZE);
    }
  }, [sessionKeyForPaging]);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentInfo | null>(null);
  const [composerMinimized, setComposerMinimized] = useState(false);
  const minimizedExpandRef = useRef<HTMLButtonElement | null>(null);
  // True while the viewport is at/near the conversation bottom. Drives the
  // anchored render window in CommittedTranscript.
  const [nearBottom, setNearBottom] = useState(true);
  useEffect(() => {
    if (loading) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    let raf: number | null = null;
    const update = () => {
      raf = null;
      const next = el.scrollTop + el.clientHeight >= el.scrollHeight - 96;
      setNearBottom((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (raf === null) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [loading, scrollContainerRef]);
  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
    setNearBottom(true);
  }, [scrollContainerRef]);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  // "auto" (observer fired while scrolling) anchors the viewport to the old
  // content; "click" (user pressed the banner) reveals the loaded messages at
  // the top of the viewport instead.
  const loadMoreModeRef = useRef<"auto" | "click">("auto");

  // IntersectionObserver on the sentinel banner at the top of the message
  // list. When the user scrolls near the top, load the next page of older
  // messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Only auto-load on a genuine upward scroll. On fresh open the
        // sentinel sits at the top of the rendered window and is visible at
        // scrollTop = 0 — auto-loading then races the initial scroll-to-bottom
        // (the capture happens before the scroll, and the restore pins the
        // viewport to the top of the last page until every page is loaded).
        if (entries[0]?.isIntersecting && container.scrollTop > 0) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          loadMoreModeRef.current = "auto";
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      // Expand the root upward so the page loads while the banner is still
      // below the top edge — by the time the user reaches the top, the loaded
      // messages are already there and the scroll continues into them.
      { root: container, rootMargin: LOAD_MORE_ROOT_MARGIN, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (loadMoreModeRef.current === "click") {
      // Explicit request: reveal the loaded page. The browser's scroll
      // anchoring already kept the previous content in view, so move the
      // viewport up to the loaded messages.
      const sentinel = sentinelRef.current;
      if (sentinel) {
        // More pages remain: place the banner's bottom edge just above the
        // viewport so the newest loaded message is at the top.
        const containerRect = container.getBoundingClientRect();
        const sentinelRect = sentinel.getBoundingClientRect();
        container.scrollTop = container.scrollTop + (sentinelRect.bottom - containerRect.top) + 1;
      } else {
        // Everything loaded — the banner unmounted; show the top of the session.
        container.scrollTop = 0;
      }
    } else {
      container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    }
    loadMoreModeRef.current = "auto";
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);

  const handleLoadMoreClick = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      // Sentinel value so the restore effect above runs and reveals the loaded messages.
      prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    }
    loadMoreModeRef.current = "click";
    setVisibleCount((prev) => getNextVisibleCount(prev));
  }, [scrollContainerRef]);

  // Switching between the compacted and the full history replaces the whole
  // transcript. Keep the messages the user was reading at the same place on
  // screen: remember the visible messages and their offsets, keep the same
  // tail of rows rendered, and scroll the first one still present back into
  // position once the other view has arrived.
  const renderedRowCountRef = useRef(0);
  const compactionToggleAnchorRef = useRef<{
    show: boolean;
    firstEntryId: string | undefined;
    candidates: { entryId: string; offset: number }[];
  } | null>(null);
  const handleTogglePreCompactionHistory = useCallback(() => {
    const container = scrollContainerRef.current;
    const candidates: { entryId: string; offset: number }[] = [];
    if (container) {
      // The viewport may show only rows without an anchor (folded process
      // details), so consider every rendered anchor and prefer the ones
      // nearest the top of the viewport.
      const top = container.getBoundingClientRect().top;
      for (const element of container.querySelectorAll<HTMLElement>("[data-entry-id]")) {
        const entryId = element.dataset.entryId;
        if (entryId) candidates.push({ entryId, offset: element.getBoundingClientRect().top - top });
      }
      candidates.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
    }
    compactionToggleAnchorRef.current = { show: !showPreCompactionHistory, firstEntryId: entryIds[0], candidates };
    // The compaction summary changes position between the two views, so keep
    // a couple of extra rows: every message on screen stays rendered.
    setVisibleCount((prev) => Math.max(prev, renderedRowCountRef.current + 2));
    togglePreCompactionHistory();
  }, [entryIds, showPreCompactionHistory, togglePreCompactionHistory, scrollContainerRef]);
  useLayoutEffect(() => {
    const anchor = compactionToggleAnchorRef.current;
    if (!anchor || anchor.show !== showPreCompactionHistory || anchor.firstEntryId === entryIds[0]) return;
    compactionToggleAnchorRef.current = null;
    const container = scrollContainerRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const elements = new Map<string, HTMLElement>();
    for (const element of container.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      if (element.dataset.entryId) elements.set(element.dataset.entryId, element);
    }
    for (const candidate of anchor.candidates) {
      const element = elements.get(candidate.entryId);
      if (!element) continue;
      container.scrollTop += element.getBoundingClientRect().top - top - candidate.offset;
      return;
    }
  }, [entryIds, showPreCompactionHistory, scrollContainerRef]);

  // `messages` gets a new identity on every update; publish only real changes.
  const lastSpeedSample = generationSpeed?.samples.at(-1);
  const generationSpeedKey = generationSpeed
    ? `${generationSpeed.current ?? "null"}|${generationSpeed.average ?? "null"}|${generationSpeed.samples.length}|${lastSpeedSample?.timestamp ?? ""}:${lastSpeedSample?.durationMs ?? ""}`
    : null;
  const generationSpeedRef = useRef(generationSpeed);
  generationSpeedRef.current = generationSpeed;
  useEffect(() => {
    onGenerationSpeedChange?.(generationSpeedRef.current);
  }, [generationSpeedKey, onGenerationSpeedChange]);
  useEffect(() => () => { onGenerationSpeedChange?.(null); }, [onGenerationSpeedChange]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);


  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addFiles(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const conversationMeta = useMemo(() => {
    const toolResultsMap = new Map<string, ToolResultMessage>();
    let lastAnchorIdx = -1;
    let hasCompaction = false;
    const visibleRefIndexByMessage = new Map<number, number>();
    let refIdx = 0;

    messages.forEach((message, index) => {
      if (message.role === "toolResult") toolResultsMap.set((message as ToolResultMessage).toolCallId, message as ToolResultMessage);
      if (message.role === "custom" && message.customType === "compaction") hasCompaction = true;
      if (isGroupAnchor(message)) lastAnchorIdx = index;
      if (message.role === "user" || message.role === "assistant") visibleRefIndexByMessage.set(index, refIdx++);
    });
    return { toolResultsMap, lastAnchorIdx, hasCompaction, visibleRefIndexByMessage };
  }, [messages]);
  // Runtime tool results span committed messages plus the tool calls omp is
  // still executing. A committed result always wins; the live snapshot only
  // covers the window between `tool_execution_start` and the toolResult message
  // landing, which is what makes the row show a running indicator and streamed
  // output instead of a dead "no result" row.
  const toolResultsWithLive = useMemo<Map<string, ToolResultMessage>>(() => {
    if (liveToolResults.size === 0) return conversationMeta.toolResultsMap;
    const merged = new Map(liveToolResults);
    for (const [toolCallId, result] of conversationMeta.toolResultsMap) merged.set(toolCallId, result);
    return merged;
  }, [liveToolResults, conversationMeta]);
  const conversationMetaWithLive = useMemo(
    () => (toolResultsWithLive === conversationMeta.toolResultsMap
      ? conversationMeta
      : { ...conversationMeta, toolResultsMap: toolResultsWithLive }),
    [conversationMeta, toolResultsWithLive],
  );
  // The ref array is sized by the count of user/assistant messages — exactly
  // what conversationMeta's visibleRefIndexByMessage already tallies, so no
  // separate filter pass (which would re-run on every streaming frame).
  const messageRefs = useMessageRefs(conversationMeta.visibleRefIndexByMessage.size);
  // Tool-call ids already rendered by COMMITTED messages — memoized away from
  // the streaming path so a per-token update only re-scans the live bubble.
  const committedToolCallIds = useMemo(() => {
    const renderedIds = new Set<string>();
    for (const message of messages) {
      if (message?.role !== "assistant") continue;
      for (const block of (message as Partial<AssistantMessage>).content ?? []) {
        if (block.type === "toolCall") renderedIds.add(block.toolCallId);
      }
    }
    return renderedIds;
  }, [messages]);
  const pendingToolHeaders = useMemo(() => {
    if (agentPhase?.kind !== "running_tools") return [];
    const renderedIds = new Set(committedToolCallIds);
    const streaming = streamState.streamingMessage;
    if (streaming?.role === "assistant") {
      for (const block of (streaming as Partial<AssistantMessage>).content ?? []) {
        if (block.type === "toolCall") renderedIds.add(block.toolCallId);
      }
    }
    return agentPhase.tools.filter((tool) => !renderedIds.has(tool.id));
  }, [agentPhase, committedToolCallIds, streamState.streamingMessage]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  // Reset minimized state on session switch (session-scoped)
  useEffect(() => { setComposerMinimized(false); }, [sessionKeyForPaging]);
  // The extension dialog renders inside the collapsible composer wrapper;
  // never let a pending approval prompt sit hidden behind the minimized pill.
  useEffect(() => { if (extensionDialog) setComposerMinimized(false); }, [extensionDialog]);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  const displayModelKey = displayModelValue ? `${displayModelValue.provider}:${displayModelValue.modelId}` : "";
  const availableThinkingLevels = useMemo(
    () =>
      displayModelValue
        ? resolveAvailableThinkingLevels(
            modelThinkingLevels[displayModelKey],
            displayModelValue,
            liveModelMeta,
          )
        : null,
    [displayModelKey, displayModelValue, modelThinkingLevels, liveModelMeta],
  );

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // Resolve the advisor role's display model + reasoning effort for the
  // composer tooltips. The raw selector is "provider/id[:effort]" from
  // ~/.omp/agent/config.yml.
  const [advisorRoleSelector, setAdvisorRoleSelector] = useState<string | null>(null);
  useEffect(() => {
    if (!advisorEnabled) {
      setAdvisorRoleSelector(null);
      return;
    }
    const controller = new AbortController();
    fetch("/api/model-roles", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ roles?: Record<string, string> }> : null)
      .then((data) => setAdvisorRoleSelector(data?.roles?.advisor ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [advisorEnabled]);

  // GitHub repo of the session checkout, so bare `#123` in messages links to it.
  const [githubRepo, setGithubRepo] = useState<string | null>(null);
  useEffect(() => {
    setGithubRepo(null);
    if (!messageCwd) return;
    const controller = new AbortController();
    fetch(`/api/github-repo?cwd=${encodeURIComponent(messageCwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ repo?: string | null }> : null)
      .then((data) => setGithubRepo(data?.repo ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [messageCwd]);

  const advisorModelMeta = useMemo(() => {
    if (!advisorRoleSelector) return null;
    const [qualified, effort] = advisorRoleSelector.split(":");
    const separator = qualified.indexOf("/");
    const provider = separator === -1 ? "" : qualified.slice(0, separator);
    const id = separator === -1 ? qualified : qualified.slice(separator + 1);
    return {
      name: modelList.find((entry) => entry.provider === provider && entry.id === id)?.name ?? advisorRoleSelector,
      reasoning: effort || null,
    };
  }, [advisorRoleSelector, modelList]);

  // Ghost-text word completion rides the session's live omp process (the route
  // never spawns one for a keystroke); before the first send there is none.
  const handlePredictWord = useCallback(async (text: string, cursor: number) => {
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return null;
    const data = await sendAgentCommand<{ suffix: string | null } | null>(sid, { type: "predict_word", text, cursor });
    return data?.suffix ?? null;
  }, [session?.id, sessionIdRef]);
  const handlePredictWordFeedback = useCallback((text: string, cursor: number, suggestion: string, accepted: boolean) => {
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "predict_word_feedback", text, cursor, suggestion, accepted }).catch(() => {});
  }, [session?.id, sessionIdRef]);

  const handleMinimize = useCallback(() => {
    setComposerMinimized(true);
    /* Focus the pill's expand button after React commits the visibility change */
    requestAnimationFrame(() => minimizedExpandRef.current?.focus());
  }, []);
  const handleExpand = useCallback(() => {
    setComposerMinimized(false);
    /* Focus the textarea after React commits the visibility change */
    requestAnimationFrame(() => chatInputRef?.current?.focus());
  }, [chatInputRef]);
  const composerStatusText = useMemo(() => {
    if (bashRunning && !pendingBash) {
      return t("chatWindow.runningCommand");
    }
    if (isCompacting || (agentRunning && !streamState.streamingMessage && pendingToolHeaders.length === 0)) {
      return [
        phaseLabel(agentPhase),
        activeSubagentCount > 0 ? tn("chatWindow.subagentCount", activeSubagentCount) : null,
        isCompacting ? t("chatWindow.compactingContext") : null,
        currentTodoPhase
          ? t("chatWindow.todoPhaseStatus", {
              name: currentTodoPhase.name,
              done: currentTodoPhase.done,
              total: currentTodoPhase.total,
            })
          : null,
      ].filter(Boolean).join(" · ");
    }
    return null;
  }, [bashRunning, pendingBash, isCompacting, agentRunning, streamState.streamingMessage, pendingToolHeaders.length, agentPhase, activeSubagentCount, currentTodoPhase, t, tn]);


  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onPredictWord={handlePredictWord}
      onPredictWordFeedback={handlePredictWordFeedback}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelsLoading={modelsLoading}
      modelError={modelError}
      onModelChange={handleModelChange}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactResult={compactResult}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      toolPreset={toolPreset}
      onToolPresetChange={handleToolPresetChange}
      fastModeEnabled={fastModeEnabled}
      fastModeActive={fastModeActive}
      fastModeSupported={Boolean(displayModelValue && modelList.some((entry) => entry.provider === displayModelValue.provider && entry.id === displayModelValue.modelId && entry.supportsFastMode))}
      onFastModeChange={session || isNew ? handleFastModeChange : undefined}
      accountSessionId={routingSessionId}
      accountRoutingBusy={routingInitializing}
      pendingAccountPins={pendingAccountPins}
      onPendingAccountPinsChange={session || isNew ? setPendingAccountPins : undefined}
      pendingProviderPin={pendingProviderPin}
      onPendingProviderPinChange={setPendingProviderPin}
      onAbortRetry={session ? handleAbortRetry : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      modelNameOverride={liveModelMeta?.name ?? null}
      retryInfo={retryInfo}
      activeGoal={activeGoal}
      activePlan={activePlan}
      advisorEnabled={advisorEnabled}
      onAdvisorChange={handleAdvisorChange}
      advisorModel={advisorModelMeta}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      advisorActive={advisorActive}
      onCompact={handleCompact}
      contextUsage={contextUsage}
      sessionStats={sessionStats}
      modelCapacity={modelCapacity}
      generationSpeed={generationSpeed}
      onRemoveQueuedMessage={removeQueuedMessage}
      onPromoteQueuedToSteer={promoteQueuedToSteer}
      scheduledMessages={session ? scheduled.messages : undefined}
      onScheduleMessage={session ? scheduled.schedule : undefined}
      onCancelScheduledMessage={scheduled.cancel}
      onSendScheduledMessageNow={scheduled.sendNow}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      /* The pill bar and chevron only render in the non-empty layout; don't
         accept minimize shortcuts in the fresh-chat branch where there is
         nothing to collapse. */
      onMinimize={isEmptyNew ? undefined : handleMinimize}
      statusText={composerStatusText}
      onOpenProviders={onOpenProviders}
      continuePrompt={session && messages.length > 0 ? t("chatInput.continuePrompt") : undefined}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return <WorkspaceState kind="loading" title={t("chatWindow.loadingSession")} />;
  }

  if (error) {
    return (
      <WorkspaceState
        kind="error"
        title={error}
        detail={(
          <button
            className="load-retry-button"
            type="button"
            onClick={retrySession}
            style={{ justifySelf: "start", minHeight: 36, padding: "6px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontWeight: 600, transition: "background var(--dur-fast) var(--ease-out-warm), transform var(--dur-fast) var(--ease-out-warm)" }}
          >
            {t("chatWindow.retry")}
          </button>
        )}
      />
    );
  }
  return (
    <SpeechSynthesisProvider value={tts}>
    <GithubRepoContext.Provider value={githubRepo}>
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="drop-zone-overlay pointer-events-none absolute inset-0 z-50 flex items-center justify-center backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="drop-ripple-ring absolute h-180 w-180 rounded-full border-[1.5px] border-solid"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-zone-illustration"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="color-mix(in srgb, var(--accent) 8%, transparent)" stroke="color-mix(in srgb, var(--accent) 50%, transparent)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="color-mix(in srgb, var(--accent) 16%, transparent)" stroke="color-mix(in srgb, var(--accent) 40%, transparent)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="color-mix(in srgb, var(--accent) 55%, transparent)" strokeWidth="1.6"/>
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <SubagentTranscriptDialog
        subagent={selectedSubagent}
        sessionId={session?.id ?? sessionIdRef.current ?? null}
        transcriptVersion={selectedSubagent ? (subagentTranscriptVersions[selectedSubagent.id] ?? 0) : 0}
        events={selectedSubagent ? (subagentEvents[selectedSubagent.id] ?? []) : undefined}
        onClose={() => setSelectedSubagent(null)}
      />

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto py-8" style={{ minHeight: 0, paddingInline: CHAT_COLUMN_PADDING }}>
          <div className="w-full" style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH }}>
            <div
               className="mb-3 empty-chat-brand"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 8,
                marginRight: 8,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <OmpWebLogo size={26} />
                <span className="omp-wordmark" style={{ fontSize: 18, color: "var(--text)", fontWeight: 600, letterSpacing: "0.02em", flexShrink: 0, whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>omp web</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <OmpRuntimeVersion />
              </div>
            </div>
            {newSessionWorkspace}
            <NoticeShelf notices={notices} onDismiss={dismissNotice} align="right" />
            {/* ChatInput insets itself by CHAT_COLUMN_PADDING; cancel this column's
                padding so the composer matches its in-session width. */}
            <div style={{ margin: `0 -${CHAT_COLUMN_PADDING}px` }}>{chatInputElement}</div>
          </div>
        </div>
        </div>
      ) : (
      <>
      <div className="relative flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: 0,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: isMobile ? CHAT_COLUMN_MAX_WIDTH : CHAT_COLUMN_MAX_WIDTH_DESKTOP, margin: "0 auto" }}>
            <NoticeShelf notices={notices} onDismiss={dismissNotice} floating align="right" />
          </div>
        </div>
        {/* Hide the Firefox scrollbar on desktop only: ChatMinimap provides the
            position indicator there, but on mobile there is no minimap and
            users need the scrollbar (Chrome's overlay scrollbar still shows). */}
        <div ref={scrollContainerRef} data-selection-scope="chat" tabIndex={-1} role="log" aria-live={streamState.isStreaming ? "off" : "polite"} aria-busy={streamState.isStreaming || undefined} aria-relevant="additions text" aria-label={t("chatWindow.conversation")} className={`flex-1 overflow-y-auto pt-6` + (isMobile ? "" : " scrollbar-none [&::-webkit-scrollbar]:hidden")} style={{ minHeight: 0 }}>
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ maxWidth: isMobile ? CHAT_COLUMN_MAX_WIDTH : CHAT_COLUMN_MAX_WIDTH_DESKTOP, margin: "0 auto" }}>
              <ExtensionStatusBar statuses={extensionStatuses} />
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {conversationMeta.hasCompaction && (
              <div
                className="compacted-history-notice wallpaper-surface"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                  marginBottom: 8, padding: "7px 10px", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)", background: "var(--bg-subtle)",
                }}
              >
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {showPreCompactionHistory ? t("chatWindow.fullHistoryVisible") : t("chatWindow.compactedHistoryNotice")}
                </span>
                <button
                  type="button"
                  onClick={handleTogglePreCompactionHistory}
                  style={{
                    flexShrink: 0, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12,
                  }}
                >
                  {showPreCompactionHistory ? t("chatWindow.returnToCompactHistory") : t("chatWindow.viewPreCompactionHistory")}
                </button>
              </div>
            )}
            <CommittedTranscript
              messages={messages}
              entryIds={entryIds}
              conversationMeta={conversationMetaWithLive}
              messageRefs={messageRefs}
              isStreaming={streamState.isStreaming}
              sessionBusy={sessionBusy}
              isNew={isNew}
              forkingEntryId={forkingEntryId}
              handleFork={handleFork}
              handleEditFromHere={handleEditFromHere}
              modelNames={modelNames}
              messageCwd={messageCwd}
              onOpenFile={onOpenFile}
              sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
              visibleCount={visibleCount}
              nearBottom={nearBottom}
              sentinelRef={sentinelRef}
              handleLoadMoreClick={handleLoadMoreClick}
              renderedRowCountRef={renderedRowCountRef}
            />
            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView
                key={streamState.streamingMessage.timestamp ?? "stream"}
                message={streamState.streamingMessage as AgentMessage}
                modelNames={modelNames}
                cwd={messageCwd}
                onOpenFile={onOpenFile}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                toolResults={toolResultsWithLive}
                toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
                liveTokensPerSecond={tokensPerSecond}
              />
            )}

            {toolCallsDefaultCollapsed && pendingToolHeaders.map((tool) => (
              <div
                key={tool.id}
                className="pending-tool-notice wallpaper-surface"
                role="status"
                aria-label={t("chatWindow.runningNamed", { names: tool.name })}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  marginBottom: 8, padding: "6px 10px",
                  border: "1px solid color-mix(in srgb, var(--status-success) 25%, transparent)",
                  borderRadius: "var(--radius-control)",
                  background: "color-mix(in srgb, var(--status-success) 4%, transparent)",
                  color: "var(--text-muted)", fontSize: 12,
                }}
              >
                <span aria-hidden className="live-status-dot live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span style={{ color: "var(--status-success)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11 }}>{tool.name}</span>
              </div>
            ))}


            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
        {!nearBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            title={t("chatWindow.scrollToBottom")}
            aria-label={t("chatWindow.scrollToBottom")}
            className="chat-scroll-bottom ui-focus-ring"
            style={{ position: "absolute", right: isMobile ? 16 : 48, bottom: 16, zIndex: 35, display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", boxShadow: "var(--shadow-pop)" }}
          >
            <ArrowDown size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        {isMobile ? null : (
          <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, zIndex: 30, display: "flex", alignItems: "center", pointerEvents: "none" }}>
            <ChatMinimap
              messages={messages}
              scrollContainer={scrollContainerRef}
              messageRefs={messageRefs}
            />
          </div>
        )}
      </div>

      {/* Minimized pill bar - shown when composer is collapsed */}
      {composerMinimized && (
        <MinimizedComposerBar
          draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
          isStreaming={sessionBusy}
          isCompacting={isCompacting}
          statusText={composerStatusText}
          expandRef={minimizedExpandRef}
          onExpand={handleExpand}
          onAbort={handleAbort}
          onAbortCompaction={handleAbortCompaction}
        />
      )}

      {/* Full composer - always mounted; hidden when minimized to preserve ref + state.
          A flex column that may shrink: when the panels + widgets + input are
          taller than the viewport (soft keyboard up, Tasks expanded), the
          panels block below scrolls and the input stays reachable instead of
          being clipped off the bottom. */}
      <div className="relative" style={{ display: composerMinimized ? "none" : "flex", flexDirection: "column", minHeight: 0 }}>
        {/* Minimize chevron above the composer area */}
        <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px`, flexShrink: 0 }}>
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto", display: "flex", justifyContent: "center" }}>
            <button
              type="button"
              onClick={handleMinimize}
              title={t("chatWindow.minimizeComposer")}
              aria-label={t("chatWindow.minimizeComposer")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 44, height: 24,
                background: "none", border: "none",
                color: "var(--text-dim)",
                cursor: "pointer", padding: 0,
                borderRadius: 4,
                transition: "color var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
            >
              <ChevronDown size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
            {extensionDialog && (
              <div style={{ marginBottom: 8 }}>
                <ExtensionDialog
                  request={extensionDialog}
                  onRespond={respondToExtensionUi}
                  attached
                />
              </div>
            )}
            <ComposerPanels
              todoPhases={todoPhases}
              subagents={subagents}
              onSelectSubagent={setSelectedSubagent}
            />
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
      </div>
      </>
      )}
      </div>
    </GithubRepoContext.Provider>
    </SpeechSynthesisProvider>
  );
}

function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          className="ui-compact-surface extension-status-surface wallpaper-surface"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: "var(--radius-control)",
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{status.key}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{renderAnsiLine(status.text, status.key)}</span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
      {widgets.map((widget) => (
        <pre
          key={widget.key}
          className="ui-compact-surface extension-widget-surface wallpaper-surface"
          role="group"
          aria-label={widget.key}
          title={widget.key}
          style={{ margin: 0, padding: "8px 9px", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}
        >
          {widget.lines.map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `${widget.key}-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, onDismiss, floating = false, align = "left" }: { notices: NoticeItem[]; onDismiss?: (id: string) => void; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
        pointerEvents: floating ? "auto" : undefined,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "var(--status-error)"
          : notice.type === "warning"
            ? "var(--status-warning)"
            : notice.type === "success"
              ? "var(--status-success)"
              : "var(--accent)";
        const isError = notice.type === "error";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item wallpaper-surface"
            style={{
              display: "flex",
              alignItems: isError ? "flex-start" : "center",
              gap: 8,
              minHeight: 36,
              height: isError ? "auto" : 36,
              maxHeight: isError ? 96 : 48,
              marginBottom: index === notices.length - 1 ? 0 : 4,
              overflow: "hidden",
              borderRadius: "var(--radius-control)",
              border: `1px solid ${isError ? "color-mix(in srgb, var(--status-error) 35%, var(--border))" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              background: isError ? "color-mix(in srgb, var(--status-error) 7%, var(--bg))" : "var(--bg)",
              color: isError ? "var(--text)" : "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 640px)",
              boxShadow: floating ? "var(--shadow-pop)" : "var(--shadow-card)",
              fontSize: 12,
              lineHeight: 1.4,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out var(--dur-med) ease-in forwards"
                : "notice-shelf-in var(--dur-med) var(--ease-out-warm) both",
              padding: isError ? "8px 8px 8px 10px" : "0 10px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                marginTop: isError ? 6 : 0,
              }}
            />
            <span
              style={{
                padding: isError ? "0" : "8px 0",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                display: isError ? "-webkit-box" : "block",
                WebkitLineClamp: isError ? 3 : undefined,
                WebkitBoxOrient: isError ? "vertical" as const : undefined,
                overflowWrap: "anywhere",
                whiteSpace: isError ? "normal" : "nowrap",
                textOverflow: isError ? "clip" : "ellipsis",
                flex: 1,
              }}
              title={notice.message}
            >
              {notice.message}
            </span>
            {onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(notice.id)}
                aria-label="Dismiss"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  padding: 0,
                  border: 0,
                  borderRadius: "var(--radius-control)",
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  flexShrink: 0,
                  marginTop: isError ? 1 : 0,
                }}
              >
                <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>×</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: () => onInput(request, "\x03"),
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        ref={panelRef}
        aria-label={t("chatWindow.extensionPanel")}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
          aria-label={t("chatWindow.extensionTerminalInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chatWindow.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("chatWindow.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}

/** Slim pill bar replacing the full composer when minimized. */
const MinimizedComposerBar = memo(function MinimizedComposerBar({ draftKey, isStreaming, isCompacting, statusText, expandRef, onExpand, onAbort, onAbortCompaction }: {
  draftKey?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  statusText?: string | null;
  expandRef?: Ref<HTMLButtonElement>;
  onExpand: () => void;
  onAbort: () => void;
  onAbortCompaction?: () => void;
}) {
  const { t } = useI18n();

  /* Read draft summary for preview without cloning attachment payloads */
  const summary = draftKey ? getDraftSummary(draftKey) : null;
  const draftText = summary?.text?.trim() || null;
  const hasAttachments = summary?.hasAttachments ?? false;
  return (
    <div style={{ flexShrink: 0, padding: "4px 16px calc(6px + env(safe-area-inset-bottom))" }}>
      <div style={{ maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto" }}>
        <div
          className="composer-minimized wallpaper-surface"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            height: 36,
            background: "var(--bg)",
            border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
            overflow: "hidden",
          }}
        >
          {/* Expand button - fills remaining space */}
          <button
            ref={expandRef}
            type="button"
            onClick={onExpand}
            title={t("chatWindow.expandComposer")}
            aria-label={t("chatWindow.expandComposer")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: 1,
              minWidth: 0,
              height: "100%",
              padding: "0 14px",
              background: "none",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <ChevronUp size={14} strokeWidth={1.8} style={{ flexShrink: 0, color: "var(--text-dim)" }} />
            {hasAttachments && (
              <Paperclip size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
            )}
            {statusText ? (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                color: "var(--text-muted)",
              }}>
                <WhaleTail active width={16} style={{ color: "var(--accent)" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {statusText}
                </span>
              </span>
            ) : (
              <span style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 14,
                color: draftText ? "var(--text)" : "var(--text-dim)",
              }}>
                {draftText ?? t("chatInput.placeholder")}
              </span>
            )}
          </button>

          {/* Stop button - sibling, only when agent is running */}
          {isStreaming && (
            <button
              type="button"
              onClick={() => {
                if (isCompacting && onAbortCompaction) onAbortCompaction();
                else onAbort();
              }}
              title={t("chatInput.stopAgent")}
              aria-label={t("chatInput.stopAgent")}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                height: 26,
                padding: "0 12px",
                marginRight: 5,
                background: "var(--accent-strong)",
                border: "none",
                borderRadius: 7,
                color: "var(--on-accent)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              <Square size={9} strokeWidth={0} fill="currentColor" aria-hidden="true" />
              {t("chatInput.stop")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
