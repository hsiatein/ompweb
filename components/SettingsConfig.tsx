"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { getHideCompactedHistory, getSubmitDuringRunBehavior, getWordCompletionMode, setHideCompactedHistory, setSubmitDuringRunBehavior, setWordCompletionMode, type SubmitDuringRunBehavior, type WordCompletionMode } from "@/lib/composer-prefs";
import { getTerminalCommandMode, getTerminalSshHost, setTerminalCommandMode, setTerminalSshHost, type TerminalCommandMode } from "@/lib/native-terminal-prefs";
import { getWhaleTailMotion, setWhaleTailMotion, type WhaleTailMotion } from "@/lib/whale-tail";
import { WhaleTailPicker } from "./WhaleTail";
import dynamic from "next/dynamic";
import { ArrowLeft, Copy, Download, ExternalLink, KeyRound, Lock, RefreshCw, RotateCcw, Search, Monitor, Play, Square, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { formatApiError } from "@/lib/i18n/api-error";
import { Alert, Select, ToggleSwitch } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SettingsTabs, type AppearanceTab, type ProvidersTab, type SettingsTab, SETTINGS_CATEGORIES } from "./SettingsTabs";
import { copyText } from "@/lib/clipboard";
import type { AppUpdateInfo } from "./AppUpdateDialog";
import type { OmpUpdateStatus } from "@/lib/omp/updates";
import { useFontSize, type FontSizePreference } from "@/hooks/useFontSize";
import { useUiScale, type UiScalePreference } from "@/hooks/useUiScale";
import { ALL_THEMES, useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
const SettingsTabLoading = () => {
  const { t } = useI18n();
  return <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("settingsConfig.loadingSettings")}</div>;
};
const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { loading: SettingsTabLoading, ssr: false });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), { loading: SettingsTabLoading, ssr: false });
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig), { loading: SettingsTabLoading, ssr: false });
const AgentsConfig = dynamic(() => import("./AgentsConfig").then((module) => module.AgentsConfig), { loading: SettingsTabLoading, ssr: false });
const AgentInstructionsConfig = dynamic(() => import("./AgentInstructionsConfig").then((module) => module.AgentInstructionsConfig), { loading: SettingsTabLoading, ssr: false });
const UsageConfig = dynamic(() => import("./UsageConfig").then((module) => module.UsageConfig), { loading: SettingsTabLoading, ssr: false });
const PetsConfig = dynamic(() => import("./PetsConfig").then((module) => module.PetsConfig), { loading: SettingsTabLoading, ssr: false });
const WallpapersConfig = dynamic(() => import("./WallpapersConfig").then((module) => module.WallpapersConfig), { loading: SettingsTabLoading, ssr: false });
const KeyboardShortcutsConfig = dynamic(() => import("./KeyboardShortcutsConfig").then((module) => module.KeyboardShortcutsConfig), { loading: SettingsTabLoading, ssr: false });
const APPEARANCE_TABS: readonly AppearanceTab[] = ["display", "wallpapers", "pets", "motion"];
const GENERAL_TABS = ["layout", "behavior", "shortcuts"] as const;
type GeneralTab = typeof GENERAL_TABS[number];
const AGENT_TABS = ["instructions", "subagents", "runtime", "approvals"] as const;
type AgentTab = typeof AGENT_TABS[number];

function SettingsSubTabs<T extends string>({ id, label, tabs, value, onChange, labelFor }: {
  id: string;
  label: string;
  tabs: readonly T[];
  value: T;
  onChange: (tab: T) => void;
  labelFor: (tab: T) => string;
}) {
  return (
    <div className="providers-segmented" role="tablist" aria-label={label} aria-orientation="horizontal" style={{ marginBottom: 4, flexShrink: 0 }}>
      {tabs.map((tab, index) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${id}-tab-${tab}`}
          aria-controls={`${id}-panel-${tab}`}
          aria-selected={value === tab}
          tabIndex={value === tab ? 0 : -1}
          className={`providers-segmented-btn ui-focus-ring${value === tab ? " active" : ""}`}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => {
            const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = tabs[nextIndex];
            onChange(next);
            document.getElementById(`${id}-tab-${next}`)?.focus();
          }}
        >
          {labelFor(tab)}
        </button>
      ))}
    </div>
  );
}

type WindowsServiceStatus = {
  isWindows: boolean;
  isInstalled: boolean;
  autostart: boolean;
  isRunning: boolean;
  port: number;
  hostname: string;
  mode: "start" | "dev";
  desktopShortcutExists: boolean;
  startMenuShortcutExists: boolean;
  startupShortcutExists: boolean;
  logFile: string;
  configFile: string;
  serviceUrl: string;
  version: string;
};

type NativeSettings = {
  defaultThinkingLevel?: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  hideThinkingBlock?: boolean;
  externalThinking?: boolean;
  textVerbosity?: "low" | "medium" | "high";
  personality?: "default" | "friendly" | "pragmatic" | "none";
  advisor?: { enabled?: boolean; subagents?: boolean; syncBacklog?: "off" | "1" | "3" | "5"; immuneTurns?: number };
  task?: { maxRecursionDepth?: number; maxConcurrency?: number };
  tools?: { approvalMode?: "always-ask" | "write" | "yolo"; approval?: { bash?: "allow" | "prompt" | "deny"; extension?: "allow" | "prompt" } };
  compaction?: { enabled?: boolean; midTurnEnabled?: boolean; strategy?: "snapcompact" | "handoff" | "context-full" | "shake" | "off"; autoContinue?: boolean; remoteEnabled?: boolean; keepRecentTokens?: number };
  memory?: { backend?: "off" | "local" | "mnemopi" | "hindsight" };
  autolearn?: { enabled?: boolean; autoContinue?: boolean; minToolCalls?: number };
  mnemopi?: { scoping?: "global" | "per-project" | "per-project-tagged"; autoRecall?: boolean; autoRetain?: boolean; noEmbeddings?: boolean };
  mcp?: { enableProjectConfig?: boolean; renderMarkdownResults?: boolean; notifications?: boolean; notificationDebounceMs?: number };
  generate_image?: { enabled?: boolean };
  retry?: { enabled?: boolean; maxRetries?: number; modelFallback?: boolean };
};

const selectStyle = {
  padding: "4px var(--control-padding-inline)",
  fontSize: "var(--text-sm)",
} as const;


const chipStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontWeight: 500,
} as const;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const SettingsHighlightContext = createContext<string | null>(null);

type EnhancedChildProps = {
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

type SearchResult = {
  id: string;
  kind: "category" | "setting";
  tab: SettingsTab;
  appearanceTab?: AppearanceTab;
  generalTab?: GeneralTab;
  providersTab?: ProvidersTab;
  agentTab?: AgentTab;
  label: string;
  description: string;
  scope?: string;
  section?: string;
};

type SettingIndexEntry = {
  id: string;
  tab: SettingsTab;
  appearanceTab?: AppearanceTab;
  generalTab?: GeneralTab;
  providersTab?: ProvidersTab;
  agentTab?: AgentTab;
  sectionKey: string;
  labelKey: string;
  descKey: string;
  fallbackSection: string;
  fallbackLabel: string;
  fallbackDesc: string;
  scope?: "UI" | "Native OMP" | "Workspace";
};

const SETTING_INDEX: SettingIndexEntry[] = [
  // Interface & Behavior
  { id: "shortcuts", tab: "general", generalTab: "shortcuts", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.general.shortcuts", descKey: "shortcuts.summary", fallbackSection: "Interface & Behavior", fallbackLabel: "Keyboard Shortcuts", fallbackDesc: "Customize, disable, and restore application shortcuts", scope: "UI" },
  { id: "completion-sound", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.completionSound", descKey: "settingsConfig.completionSoundDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Completion sound", fallbackDesc: "Play a tone when the agent completes a run.", scope: "UI" },
  { id: "keep-tool-calls-collapsed", tab: "general", generalTab: "layout", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.keepToolCallsCollapsed", descKey: "settingsConfig.keepToolCallsCollapsedDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Keep tool calls collapsed", fallbackDesc: "Show only compact headers while tools execute.", scope: "UI" },
  { id: "hide-compacted-history", tab: "general", generalTab: "layout", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.hideCompactedHistory", descKey: "settingsConfig.hideCompactedHistoryDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Hide compacted messages by default", fallbackDesc: "Open sessions with the messages before their last compaction hidden. Each chat can still show or hide them with the button above its messages.", scope: "UI" },
  { id: "open-url-automatically", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.openUrlAutomatically", descKey: "settingsConfig.openUrlAutomaticallyDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Automatically open web links in the browser", fallbackDesc: "Links the agent opens from the session you are viewing open in a new tab right away. Links from other sessions always ask first. Your browser may still block pop-ups.", scope: "UI" },
  { id: "open-file-automatically", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.openFileAutomatically", descKey: "settingsConfig.openFileAutomaticallyDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Allow background sessions to open files in the side panel", fallbackDesc: "Allow agents from any session to open files in the side panel, leaving Settings if needed. Off by default; saved in this browser. File access and editing permissions are unchanged.", scope: "UI" },
  { id: "scope-native-select-all", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.scopeNativeSelectAll", descKey: "settingsConfig.scopeNativeSelectAllDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Scope native Select All (experimental)", fallbackDesc: "Limit whole-page selections from browser or touch menus to the active message, chat, or file. May also narrow deliberate whole-page selections. Turn off if selection handles or menus misbehave. Keyboard shortcuts are unaffected.", scope: "UI" },
  { id: "tts-autoplay", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.ttsAutoplay", descKey: "settingsConfig.ttsAutoplayDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Auto-read assistant responses", fallbackDesc: "Automatically read aloud new assistant replies when completed.", scope: "UI" },
  { id: "tts-voice", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.ttsVoice", descKey: "settingsConfig.ttsVoiceDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Speech Voice", fallbackDesc: "Select the browser voice for text-to-speech reading.", scope: "UI" },
  { id: "provider-usage", tab: "general", generalTab: "layout", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.providerUsage", descKey: "settingsConfig.providerUsageDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Provider usage limits", fallbackDesc: "Show provider usage in the sidebar, above Settings.", scope: "UI" },
  { id: "chat-font-size", tab: "appearance", appearanceTab: "display", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.chatFontSize", descKey: "settingsConfig.chatFontSizeDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Chat Font Size", fallbackDesc: "Adjust text size for conversation messages, code blocks, and markdown output.", scope: "UI" },
  { id: "ui-scale", tab: "appearance", appearanceTab: "display", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.uiScale", descKey: "settingsConfig.uiScaleDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Interface Scale", fallbackDesc: "Adjust overall UI zoom and display density across sidebars, dialogs, buttons, and toolbars.", scope: "UI" },
  { id: "message-during-active-run", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.messageDuringActiveRun", descKey: "settingsConfig.messageDuringActiveRunDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Message during active run", fallbackDesc: "What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish.", scope: "UI" },
  { id: "word-completion", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.wordCompletion", descKey: "settingsConfig.wordCompletionDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Word completion", fallbackDesc: "Ghost text from omp's word prediction; configure acceptance keys in Keyboard Shortcuts. Auto enables it only with a mouse or trackpad.", scope: "UI" },
  { id: "terminal-command", tab: "general", generalTab: "behavior", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.terminalCommand", descKey: "settingsHint.terminalCommand", fallbackSection: "Interface & Behavior", fallbackLabel: "Terminal command", fallbackDesc: "What the workspace menu's Copy terminal command copies: cd into the directory, or an ssh command for another computer. Auto picks cd when this page is opened via localhost.", scope: "UI" },
  { id: "terminal-command-ssh-host", tab: "general", generalTab: "behavior", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.terminalCommandSshHost", descKey: "settingsHint.terminalCommandSshHost", fallbackSection: "Interface & Behavior", fallbackLabel: "SSH host for terminal command", fallbackDesc: "Host alias from this computer's ~/.ssh/config, or user@host.", scope: "UI" },
  { id: "whale-tail", tab: "appearance", appearanceTab: "motion", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.whaleTail", descKey: "settingsConfig.whaleTailDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Whale tail animation", fallbackDesc: "How the whale tail moves beside the running status and the live thinking row.", scope: "UI" },
  { id: "theme", tab: "appearance", appearanceTab: "display", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.theme", descKey: "settingsConfig.themeDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Visual theme", fallbackDesc: "Choose a light or dark theme, or follow the system appearance.", scope: "UI" },
  { id: "wallpapers", tab: "appearance", appearanceTab: "wallpapers", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.appearance.wallpapers", descKey: "settingsConfig.wallpapersDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Wallpapers & Glass", fallbackDesc: "Wallpaper images, videos, glass effects, colors, brightness, and background audio.", scope: "UI" },
  { id: "pets", tab: "appearance", appearanceTab: "pets", sectionKey: "settingsTabs.appearance.label", labelKey: "settingsConfig.appearance.pets", descKey: "settingsConfig.petsDesc", fallbackSection: "Appearance & Personalization", fallbackLabel: "Pets", fallbackDesc: "Codex pet library, imports, size, pointer following, and animation previews.", scope: "UI" },
  // Tool Safety & Approvals
  { id: "approval-mode", tab: "agents", agentTab: "approvals", sectionKey: "settingsConfig.toolSafetyApprovals", labelKey: "settingsConfig.approvalMode", descKey: "settingsConfig.approvalModeDesc", fallbackSection: "Tool Safety & Approvals", fallbackLabel: "Approval Mode", fallbackDesc: "Choose when OMP asks before tool calls.", scope: "Native OMP" },
  { id: "bash-override", tab: "agents", agentTab: "approvals", sectionKey: "settingsConfig.toolSafetyApprovals", labelKey: "settingsConfig.bashOverride", descKey: "settingsConfig.bashOverrideDesc", fallbackSection: "Tool Safety & Approvals", fallbackLabel: "Bash Override", fallbackDesc: "Override default approval policy specifically for terminal commands.", scope: "Native OMP" },
  { id: "extension-tool-requests", tab: "agents", agentTab: "approvals", sectionKey: "settingsConfig.toolSafetyApprovals", labelKey: "settingsConfig.extensionToolRequests", descKey: "settingsConfig.extensionToolRequestsDesc", fallbackSection: "Tool Safety & Approvals", fallbackLabel: "Extension Tool Requests", fallbackDesc: "Automatically approve extension tool authorization requests.", scope: "Native OMP" },
  // Global model defaults
  { id: "reasoning", tab: "providers", providersTab: "defaults", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.reasoning", descKey: "settingsConfig.reasoningDesc", fallbackSection: "Global model defaults", fallbackLabel: "Reasoning", fallbackDesc: "Default effort level for thinking-capable models.", scope: "Native OMP" },
  { id: "verbosity", tab: "providers", providersTab: "defaults", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.verbosity", descKey: "settingsConfig.verbosityDesc", fallbackSection: "Global model defaults", fallbackLabel: "Verbosity", fallbackDesc: "Response detail level for supporting providers.", scope: "Native OMP" },
  { id: "personality", tab: "providers", providersTab: "defaults", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.personality", descKey: "settingsConfig.personalityDesc", fallbackSection: "Global model defaults", fallbackLabel: "Personality", fallbackDesc: "Style included in OMP's system prompt.", scope: "Native OMP" },
  { id: "thinking-blocks", tab: "providers", providersTab: "defaults", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.thinkingBlocks", descKey: "settingsConfig.thinkingBlocksDesc", fallbackSection: "Global model defaults", fallbackLabel: "Thinking Blocks", fallbackDesc: "Hide model reasoning from output view.", scope: "Native OMP" },
  { id: "external-thinking", tab: "providers", providersTab: "defaults", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.externalThinking", descKey: "settingsConfig.externalThinkingDesc", fallbackSection: "Global model defaults", fallbackLabel: "External Thinking", fallbackDesc: "Private scratchpad reasoning via think tool.", scope: "Native OMP" },
  // Context Compaction
  { id: "automatic-compaction", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.contextCompaction", labelKey: "settingsConfig.automaticCompaction", descKey: "settingsConfig.automaticCompactionDesc", fallbackSection: "Context Compaction", fallbackLabel: "Automatic Compaction", fallbackDesc: "Compact context before model context limit is hit.", scope: "Native OMP" },
  { id: "continue-after-compaction", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.contextCompaction", labelKey: "settingsConfig.continueAfterCompaction", descKey: "settingsConfig.continueAfterCompactionDesc", fallbackSection: "Context Compaction", fallbackLabel: "Continue After Compaction", fallbackDesc: "Resume task execution after compaction completes.", scope: "Native OMP" },
  { id: "maintenance-strategy", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.contextCompaction", labelKey: "settingsConfig.maintenanceStrategy", descKey: "settingsConfig.maintenanceStrategyDesc", fallbackSection: "Context Compaction", fallbackLabel: "Maintenance Strategy", fallbackDesc: "Select algorithm used to reduce context pressure.", scope: "Native OMP" },
  { id: "compact-mid-turn", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.contextCompaction", labelKey: "settingsConfig.compactMidTurn", descKey: "settingsConfig.compactMidTurnDesc", fallbackSection: "Context Compaction", fallbackLabel: "Compact Mid-Turn", fallbackDesc: "Check context limits between tool execution steps.", scope: "Native OMP" },
  // Memory & Auto-Learn
  { id: "memory-backend", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.memoryBackend", descKey: "settingsConfig.memoryBackendDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Memory Backend", fallbackDesc: "Where durable knowledge is stored across sessions.", scope: "Native OMP" },
  { id: "enable-auto-learn", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.enableAutoLearn", descKey: "settingsConfig.enableAutoLearnDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Enable Auto-Learn", fallbackDesc: "Capture reusable lessons after completed runs.", scope: "Native OMP" },
  { id: "private-capture-turn", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.privateCaptureTurn", descKey: "settingsConfig.privateCaptureTurnDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Private Capture Turn", fallbackDesc: "Run private lesson-capture turn at completion.", scope: "Native OMP" },
  { id: "memory-scope", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.memoryScope", descKey: "settingsConfig.memoryScopeDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Memory Scope", fallbackDesc: "Scoping for Mnemopi knowledge storage.", scope: "Native OMP" },
  { id: "recall-on-session-start", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.recallOnSessionStart", descKey: "settingsConfig.recallOnSessionStartDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Recall on Session Start", fallbackDesc: "Load relevant memories into first turn.", scope: "Native OMP" },
  { id: "retain-completed-turns", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.memoryAutoLearn", labelKey: "settingsConfig.retainCompletedTurns", descKey: "settingsConfig.retainCompletedTurnsDesc", fallbackSection: "Memory & Auto-Learn", fallbackLabel: "Retain Completed Turns", fallbackDesc: "Store completed conversation turns in memory.", scope: "Native OMP" },
  // Automatic Retry
  { id: "automatic-retry", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.automaticRetry", labelKey: "settingsConfig.retryToggle", descKey: "settingsConfig.retryToggleDesc", fallbackSection: "Automatic Retry", fallbackLabel: "Automatic Retry", fallbackDesc: "Retry failed turns automatically.", scope: "Native OMP" },
  { id: "max-attempts", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.automaticRetry", labelKey: "settingsConfig.maxAttempts", descKey: "settingsConfig.maxAttemptsDesc", fallbackSection: "Automatic Retry", fallbackLabel: "Max Attempts", fallbackDesc: "Retry limit before giving up.", scope: "Native OMP" },
  { id: "model-fallback", tab: "agents", agentTab: "runtime", sectionKey: "settingsConfig.automaticRetry", labelKey: "settingsConfig.modelFallback", descKey: "settingsConfig.modelFallbackDesc", fallbackSection: "Automatic Retry", fallbackLabel: "Model Fallback", fallbackDesc: "Fall back to alternative model when retries exhaust.", scope: "Native OMP" },
  // Agents
  { id: "agent-instructions", tab: "agents", agentTab: "instructions", sectionKey: "settingsTabs.agents.label", labelKey: "agentInstructions.title", descKey: "agentInstructions.description", fallbackSection: "Agents & Policies", fallbackLabel: "Custom instructions", fallbackDesc: "System prompt rules: model, provider, global; each rule replaces or appends to broader ones.", scope: "UI" },
  { id: "agent-roster", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "settingsConfig.agents.subagents", descKey: "settingsConfig.agentsDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Subagents", fallbackDesc: "Browse enabled agents filtered by name and source.", scope: "Native OMP" },
  { id: "subagents-enabled", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "settingsConfig.subagentsEnabled", descKey: "settingsConfig.subagentsEnabledDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Allow subagents", fallbackDesc: "Allow task and Eval delegation in newly started OMP sessions.", scope: "Native OMP" },
  { id: "subagents-depth", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "settingsConfig.subagentsDepth", descKey: "settingsConfig.subagentsDepthDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Maximum subagent depth", fallbackDesc: "Maximum nested delegation depth.", scope: "Native OMP" },
  { id: "subagents-concurrency", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "settingsConfig.subagentsConcurrency", descKey: "settingsConfig.subagentsConcurrencyDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Maximum concurrent subagents", fallbackDesc: "Concurrent subagent limit per parent.", scope: "Native OMP" },
  { id: "agent-model", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "agentsConfig.modelRoles", descKey: "modelsConfig.modelRolesDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Agent model", fallbackDesc: "Model mapping and reasoning effort per agent role.", scope: "Native OMP" },
  { id: "agent-tools", tab: "agents", agentTab: "subagents", sectionKey: "settingsTabs.agents.label", labelKey: "agentsConfig.tools", descKey: "settingsConfig.agentsDesc", fallbackSection: "Agents & Policies", fallbackLabel: "Agent tools", fallbackDesc: "Allowed tools and delegated task prompt per agent.", scope: "Native OMP" },
  // Extensions & Skills
  { id: "generate-image", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.generateImage", descKey: "settingsConfig.generateImageDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "Image generation", fallbackDesc: "Let the agent create and edit images with the generate_image tool.", scope: "Native OMP" },
  { id: "mcp-servers", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.mcpServers", descKey: "settingsConfig.mcpServersDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "MCP servers", fallbackDesc: "View MCP servers and manage the selected workspace's project configuration.", scope: "Workspace" },
  { id: "load-project-mcp-servers", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.loadProjectMcp", descKey: "settingsConfig.loadProjectMcpDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "Load Project MCP Servers", fallbackDesc: "Allow project-root MCP configuration to be discovered.", scope: "Native OMP" },
  { id: "render-mcp-markdown", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.renderMcpMarkdown", descKey: "settingsConfig.renderMcpMarkdownDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "Render MCP Markdown", fallbackDesc: "Render non-JSON MCP results as Markdown in transcript.", scope: "Native OMP" },
  { id: "mcp-resource-updates", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.mcpResourceUpdates", descKey: "settingsConfig.mcpResourceUpdatesDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "MCP Resource Updates", fallbackDesc: "Inject server resource updates into conversation.", scope: "Native OMP" },
  { id: "skills-library", tab: "extensions", sectionKey: "settingsConfig.extensionsSkills", labelKey: "settingsConfig.skillsLibrary", descKey: "settingsConfig.skillsLibraryDesc", fallbackSection: "Extensions & Skills", fallbackLabel: "Skills library", fallbackDesc: "Manage loaded skills, sources, visibility, installation, and updates.", scope: "Workspace" },
  // Usage & Analytics
  { id: "usage-summary", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.title", descKey: "settingsTabs.usage.description", fallbackSection: "Usage", fallbackLabel: "Usage & Analytics", fallbackDesc: "Tokens, costs, cache analytics, and model breakdown", scope: "UI" },
  { id: "token-cost", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.rawTokenCost", descKey: "usageConfig.billedAtFullRate", fallbackSection: "Usage", fallbackLabel: "Raw Token Cost", fallbackDesc: "Token expenditure across providers and models", scope: "UI" },
  { id: "cache-savings", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.cacheSavings", descKey: "usageConfig.costQuality", fallbackSection: "Usage", fallbackLabel: "Cache Savings", fallbackDesc: "Prompt caching savings and cost quality breakdown", scope: "UI" },
  { id: "model-breakdown", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.breakdown", descKey: "usageConfig.model", fallbackSection: "Usage", fallbackLabel: "Model Breakdown", fallbackDesc: "Historical token usage and cost per model, day, and project", scope: "UI" },
  // Windows Background Service & System Tray
  { id: "auto-resume-sessions", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.autoResumeSessions", descKey: "settingsConfig.autoResumeSessionsDesc", fallbackSection: "System & Updates", fallbackLabel: "Resume running sessions after a restart", fallbackDesc: "When omp-web restarts while agents are working, restart those sessions and tell each agent: \"Session interrupted and resumed. Continue as you would have done without the interruption.\" Work in progress at the moment of the restart, such as a running command, is lost." },
  { id: "sudo-auto-answer", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.sudoAuto", descKey: "settingsHint.sudoAuto", fallbackSection: "System & Updates", fallbackLabel: "Answer sudo automatically", fallbackDesc: "Agents' sudo commands get your password without asking until you turn this off or omp-web restarts. Turning it on asks for the password once." },
  { id: "windows-service-autostart", tab: "system", sectionKey: "settingsConfig.windowsServiceTitle", labelKey: "settingsConfig.windowsServiceAutostart", descKey: "settingsConfig.windowsServiceAutostartDesc", fallbackSection: "Windows Background Service & System Tray", fallbackLabel: "Start with Windows", fallbackDesc: "Launch background service quietly in system tray when logging into Windows.", scope: "UI" },
  { id: "windows-service-shortcuts", tab: "system", sectionKey: "settingsConfig.windowsServiceTitle", labelKey: "settingsConfig.windowsServiceInstallBtn", descKey: "settingsConfig.windowsServiceDesc", fallbackSection: "Windows Background Service & System Tray", fallbackLabel: "Install Service & Shortcuts", fallbackDesc: "Manage background service execution, system tray monitor, Windows logon autostart, and Desktop shortcuts.", scope: "UI" },
];

function SearchResultsList({ results, query, onSelect }: { results: SearchResult[]; query: string; onSelect: (result: SearchResult) => void }) {
  const { t, tn } = useI18n();
  const isMobile = useIsMobile();
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg)", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
      <div className="settings-panel-inner" style={{ gap: 12 }}>
        <div style={{ fontSize: "var(--text-md)", color: "var(--text-muted)", marginBottom: 4 }}>
          {results.length === 0 ? t("settingsConfig.noSettingsMatch", { query }) : tn("settingsConfig.searchResults", results.length, { count: results.length, query })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => onSelect(result)}
              className="settings-card"
              style={{
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 4,
                padding: "14px 18px",
                width: "100%",
                boxSizing: "border-box",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{result.label}</span>
                {result.kind === "category" && (
                  <span style={chipStyle}>{t("settingsConfig.chipSection")}</span>
                )}
                {result.scope === "UI" && (
                  <span style={chipStyle}>{t("settingsConfig.deviceOnly")}</span>
                )}
              </div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.45 }}>{result.description}</div>
              {result.section && <div style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{result.section}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Server-side omp-web setting (lib/web-settings.ts), loaded on mount. */
function AutoResumeSessionsSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { autoResumeSessions?: boolean } | null) => { if (alive) setEnabled(data?.autoResumeSessions === true); })
      .catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);
  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoResumeSessions: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      setEnabled(previous);
      toast.error(t("settingsConfig.autoResumeSessionsSaveFailed"), error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <NativeSetting searchId="auto-resume-sessions" label={t("settingsConfig.autoResumeSessions")} description={t("settingsHint.autoResumeSessions")}>
      <ToggleSwitch checked={enabled === true} disabled={enabled === null} onChange={(next) => void change(next)} />
    </NativeSetting>
  );
}

/**
 * Answer agents' sudo prompts automatically (lib/askpass.ts). Turning it on
 * asks for the sudo password once; the server verifies it and keeps it in
 * memory until this is turned off or omp-web restarts.
 */
function SudoAutoAnswerSetting() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/askpass/auto")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { supported?: boolean; enabled?: boolean } | null) => {
        if (alive) setStatus({ supported: data?.supported === true, enabled: data?.enabled === true });
      })
      .catch(() => { if (alive) setStatus({ supported: false, enabled: false }); });
    return () => { alive = false; };
  }, []);
  const put = async (body: { enabled: true; password: string } | { enabled: false }) => {
    const res = await fetch("/api/askpass/auto", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null) as { enabled?: boolean; error?: string; code?: string } | null;
    if (!res.ok) throw new Error(formatApiError(data));
    return data?.enabled === true;
  };
  const closeDialog = () => { setAsking(false); setPassword(""); setError(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    try {
      const enabled = await put({ enabled: true, password });
      setStatus((previous) => previous && { ...previous, enabled });
      closeDialog();
    } catch (failure) {
      setPassword("");
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const change = async (next: boolean) => {
    if (next) { setAsking(true); return; }
    try {
      await put({ enabled: false });
      setStatus((previous) => previous && { ...previous, enabled: false });
    } catch (failure) {
      toast.error(t("settingsConfig.sudoAutoSaveFailed"), failure instanceof Error ? failure.message : String(failure));
    }
  };
  if (status && !status.supported) return null;
  return (
    <>
      <NativeSetting searchId="sudo-auto-answer" label={t("settingsConfig.sudoAuto")} description={t("settingsHint.sudoAuto")}>
        <ToggleSwitch checked={status?.enabled === true} disabled={status === null} onChange={(next) => void change(next)} />
      </NativeSetting>
      {asking && (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) closeDialog(); }}>
          <DialogContent ariaLabel={t("settingsConfig.sudoAuto")} className="askpass-dialog" style={{ width: 460 }}>
            <DialogTitle style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <KeyRound size={18} aria-hidden="true" />
              {t("settingsConfig.sudoAuto")}
            </DialogTitle>
            <form onSubmit={(event) => void submit(event)}>
              <label className="askpass-label" htmlFor="sudo-auto-password">{t("settingsConfig.sudoAutoPassword")}</label>
              <input
                id="sudo-auto-password"
                className="askpass-input"
                type="password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); setError(null); }}
                autoComplete="off"
                autoFocus
                disabled={busy}
              />
              {error && <p role="alert" className="askpass-error">{error}</p>}
              <p className="askpass-note">
                <Lock size={12} aria-hidden="true" />
                <span>{t("settingsConfig.sudoAutoNote")}</span>
              </p>
              <div className="askpass-actions">
                <button type="button" onClick={closeDialog} disabled={busy}>{t("settingsConfig.sudoAutoCancel")}</button>
                <button type="submit" className="askpass-submit" disabled={busy || !password}>{t("settingsConfig.sudoAutoEnable")}</button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function SubagentAccessSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings", { signal: AbortSignal.timeout(12000) })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: { subagentsEnabled?: boolean }) => {
        if (alive) { setEnabled(data.subagentsEnabled === true); setLoadFailed(false); }
      })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [reload]);
  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const response = await fetch("/api/web-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subagentsEnabled: next }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    } catch (error) {
      setEnabled(previous);
      toast.error(t("settingsConfig.subagentsSaveFailed"), error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  return (
    <>
      <NativeSetting searchId="subagents-enabled" label={t("settingsConfig.subagentsEnabled")}>
        <ToggleSwitch checked={enabled === true} disabled={enabled === null || saving} onChange={(next) => void change(next)} />
      </NativeSetting>
      {loadFailed && <button type="button" className="settings-back" onClick={() => setReload((value) => value + 1)}>{t("chatWindow.retry")}</button>}
    </>
  );
}

function NativeIntegerInput({ value, minimum, onCommit, ...attributes }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue" | "onBlur"> & {
  value: number; minimum: number; onCommit: (value: number) => void;
}) {
  const { t } = useI18n();
  return (
    <input {...attributes} key={value} type="number" defaultValue={value} min={minimum} step={1}
      style={{ width: 96, maxWidth: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", fontSize: "var(--text-sm)" }}
      onBlur={(event) => {
        const next = Number(event.currentTarget.value);
        if (!event.currentTarget.value.trim() || !Number.isSafeInteger(next) || next < minimum) {
          event.currentTarget.value = String(value);
          toast.error(t("settingsConfig.subagentsInvalidLimit", { minimum }));
          return;
        }
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") event.currentTarget.value = String(value);
        event.currentTarget.blur();
      }}
    />
  );
}

/**
 * Settings that only matter while their parent is on: indented under it and dimmed + inert when it is off, so the
 * relation needs no "only applies when …" sentence. Kept mounted so search can still scroll to them.
 */
function DependentSettings({ active, label, children }: { active: boolean; label?: string; children: ReactNode }) {
  return (
    <div className="settings-dependent" data-active={active ? "true" : "false"} inert={!active}>
      {label && <div className="settings-dependent-label">{label}</div>}
      {children}
    </div>
  );
}

/** One setting row. `description` is shown only when the label and control cannot say it (search still matches SETTING_INDEX text). */
function NativeSetting({ label, description, scope, searchId, children }: { label: string; description?: string; scope?: "UI" | "Native OMP" | "Workspace"; searchId?: string; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const highlightId = useContext(SettingsHighlightContext);
  const settingSlug = searchId || slugify(label);
  const highlighted = highlightId !== null && (highlightId === settingSlug || highlightId === slugify(label));
  const settingId = 'setting-' + settingSlug;
  const labelId = 'setting-label-' + settingSlug;
  const descId = 'setting-desc-' + settingSlug;

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  let enhancedChild = children;
  if (isValidElement(children)) {
    const childProps = children.props as EnhancedChildProps;
    enhancedChild = cloneElement(children as ReactElement<EnhancedChildProps>, {
      id: childProps.id || settingId,
      "aria-labelledby": childProps["aria-labelledby"] || labelId,
      "aria-describedby": childProps["aria-describedby"] || (description ? descId : undefined),
      "aria-label": childProps["aria-label"] || label,
    });
  }

  return (
    <div
      ref={ref}
      data-search-id={settingSlug}
      className="settings-card"
      style={{
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
        marginBottom: 10,
        transition: "box-shadow var(--dur-fast), border-color var(--dur-fast)",
        ...(highlighted ? { borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)" } : {}),
      }}
    >
      <div className="settings-card-text">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: description ? 4 : 0 }}>
          <label id={labelId} htmlFor={settingId} className="settings-card-title" style={{ cursor: "pointer" }}>{label}</label>
          {/* Browser-local settings do not follow you to other devices (web on the computer, the App on the phone). */}
          {scope === "UI" && <span style={chipStyle}>{t("settingsConfig.deviceOnly")}</span>}
        </div>
        {description && <span id={descId} className="settings-card-desc">{description}</span>}
      </div>
      <span className="settings-card-control">{enhancedChild}</span>
    </div>
  );
}

export function SettingsConfig({ activeTab, appearanceTab, onAppearanceTabChange, toolCallsDefaultCollapsed, onToolCallsDefaultCollapsedChange, providerUsageVisible, onProviderUsageVisibleChange, scopeNativeSelectAll, onScopeNativeSelectAllChange, openUrlAutomatically, onOpenUrlAutomaticallyChange, openFileAutomatically, onOpenFileAutomaticallyChange, cwd, sessionId, onModelsSaved, appUpdate, onRefreshAppUpdate, onRequestAppUpdate, onSelectTab, onClose }: {
  activeTab: SettingsTab;
  appearanceTab: AppearanceTab;
  onAppearanceTabChange: (tab: AppearanceTab) => void;
  toolCallsDefaultCollapsed: boolean;
  onToolCallsDefaultCollapsedChange: (collapsed: boolean) => void;
  providerUsageVisible: boolean;
  onProviderUsageVisibleChange: (visible: boolean) => void;
  scopeNativeSelectAll: boolean;
  onScopeNativeSelectAllChange: (enabled: boolean) => void;
  openUrlAutomatically: boolean;
  onOpenUrlAutomaticallyChange: (enabled: boolean) => void;
  openFileAutomatically: boolean;
  onOpenFileAutomaticallyChange: (enabled: boolean) => void;
  cwd: string | null;
  sessionId: string | null;
  onModelsSaved: () => void;
  appUpdate: AppUpdateInfo | null;
  onRefreshAppUpdate: (force?: boolean) => Promise<AppUpdateInfo | null>;
  onRequestAppUpdate: () => void;
  onSelectTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const workspaceReady = cwd !== null;
  const { fontSize, setFontSize } = useFontSize();
  const { uiScale, setUiScale } = useUiScale();
  const { preference: themePreference, setTheme } = useTheme();
  const {
    isSupported: ttsSupported,
    autoPlayEnabled: ttsAutoPlay,
    setAutoPlay: setTtsAutoPlay,
    voices: ttsVoices,
    selectedVoiceURI: ttsVoiceURI,
    setSelectedVoiceURI: setTtsVoiceURI,
  } = useSpeechSynthesis();
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [generalTab, setGeneralTab] = useState<GeneralTab>("layout");
  const [providersTab, setProvidersTab] = useState<ProvidersTab>("connected");
  const [agentTab, setAgentTab] = useState<AgentTab>("instructions");
  const [submitBehavior, setSubmitBehavior] = useState<SubmitDuringRunBehavior>(() => getSubmitDuringRunBehavior());
  const [wordCompletion, setWordCompletion] = useState<WordCompletionMode>(() => getWordCompletionMode());
  const [hideCompactedHistory, setHideCompactedHistoryState] = useState(() => getHideCompactedHistory());
  const [terminalCommandMode, setTerminalCommandModeState] = useState<TerminalCommandMode>(() => getTerminalCommandMode());
  const [terminalSshHost, setTerminalSshHostState] = useState(() => getTerminalSshHost());
  const [whaleTail, setWhaleTail] = useState<WhaleTailMotion>(() => getWhaleTailMotion());
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const value = window.localStorage.getItem("omp-sound-enabled");
      return value === null ? true : value === "true";
    } catch {
      return true;
    }
  });
  const [update, setUpdate] = useState<OmpUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(false);
  const [appUpdateMessage, setAppUpdateMessage] = useState<string | null>(null);
  const [hasCheckedUpdates, setHasCheckedUpdates] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [windowsService, setWindowsService] = useState<WindowsServiceStatus | null>(null);
  const [loadingWindowsService, setLoadingWindowsService] = useState(false);
  const [windowsServiceActionPending, setWindowsServiceActionPending] = useState(false);

  const appUpdateIsAvailable = Boolean(appUpdate?.updateAvailable);
  const appUpdatesDisabled = Boolean(appUpdate?.updatesDisabled);
  const systemNeedsAttention = appUpdateIsAvailable;

  const attentionTabs = useMemo<Partial<Record<SettingsTab, boolean | string>>>(() => {
    const tabs: Partial<Record<SettingsTab, boolean | string>> = {};
    if (systemNeedsAttention) {
      tabs.system = t("settingsTabs.updateAvailable");
    }
    return tabs;
  }, [systemNeedsAttention, t]);

  const fetchWindowsServiceStatus = useCallback(async () => {
    try {
      setLoadingWindowsService(true);
      const res = await fetch("/api/windows-service");
      if (res.ok) {
        const data = (await res.json()) as WindowsServiceStatus;
        setWindowsService(data);
      }
    } catch {
      // ignore
    } finally {
      setLoadingWindowsService(false);
    }
  }, []);

  const performWindowsServiceAction = useCallback(async (action: "install" | "uninstall" | "toggle-autostart" | "start" | "stop" | "restart", payload: object = {}) => {
    try {
      setWindowsServiceActionPending(true);
      setMessage(null);
      const res = await fetch("/api/windows-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; status?: WindowsServiceStatus; message?: string };
      if (!res.ok || data.error) {
        setMessage(data.error || t("settingsConfig.windowsServiceActionFailed"));
      } else {
        if (data.status) setWindowsService(data.status);
        setMessage(data.message || t("settingsConfig.windowsServiceActionSuccess"));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settingsConfig.windowsServiceActionFailed"));
    } finally {
      setWindowsServiceActionPending(false);
    }
  }, [t]);


  const [nativeSettings, setNativeSettings] = useState<NativeSettings | null>(null);
  const [nativeSettingsError, setNativeSettingsError] = useState<string | null>(null);
  const [nativeSettingsLoading, setNativeSettingsLoading] = useState(true);
  const [nativeSavesInFlight, setNativeSavesInFlight] = useState(0);
  const [isPending, startTransition] = useTransition();
  const latestNativeSettingsRef = useRef<NativeSettings | null>(null);
  const nativeSaveDrainingRef = useRef(false);
  const nativeSettingsMutatedRef = useRef(false);

  const loadNativeSettings = useCallback(() => {
    nativeSettingsMutatedRef.current = false;
    setNativeSettingsLoading(true);
    setNativeSettingsError(null);
    fetch("/api/omp-settings", { signal: AbortSignal.timeout(12000) })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { settings?: NativeSettings }) => {
        if (!nativeSettingsMutatedRef.current) setNativeSettings(data.settings ?? {});
      })
      .catch((error) => setNativeSettingsError(error instanceof Error ? error.message : String(error)))
      .finally(() => setNativeSettingsLoading(false));
  }, []);

  useEffect(() => {
    void loadNativeSettings();
  }, [loadNativeSettings]);

  const saveNativeSettings = useCallback((next: NativeSettings) => {
    nativeSettingsMutatedRef.current = true;
    setNativeSettings(next);
    setNativeSettingsError(null);
    latestNativeSettingsRef.current = next;
    if (nativeSaveDrainingRef.current) return;
    nativeSaveDrainingRef.current = true;
    setNativeSavesInFlight((count) => count + 1);

    void (async () => {
      try {
        while (latestNativeSettingsRef.current !== null) {
          const snapshot = latestNativeSettingsRef.current;
          latestNativeSettingsRef.current = null;
          try {
            const response = await fetch("/api/omp-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = (await response.json()) as { settings?: NativeSettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestNativeSettingsRef.current === null) setNativeSettings(data.settings ?? snapshot);
          } catch (error) {
            setNativeSettingsError(error instanceof Error ? error.message : String(error));
            break;
          }
        }
      } finally {
        nativeSaveDrainingRef.current = false;
        setNativeSavesInFlight((count) => Math.max(0, count - 1));
      }
    })();
  }, []);

  const currentSettings = useCallback((): NativeSettings => latestNativeSettingsRef.current ?? nativeSettings ?? {}, [nativeSettings]);

  const patchSettings = useCallback((patch: Partial<NativeSettings>) => {
    void saveNativeSettings({ ...currentSettings(), ...patch });
  }, [currentSettings, saveNativeSettings]);

  const patchSection = useCallback(<K extends keyof NativeSettings,>(key: K, patch: Partial<NonNullable<NativeSettings[K]>>) => {
    // Merge into the latest copy of this section (an unsaved edit may be in flight).
    const section = ((latestNativeSettingsRef.current ?? nativeSettings)?.[key] ?? {}) as object;
    void saveNativeSettings({ ...currentSettings(), [key]: { ...section, ...patch } });
  }, [currentSettings, nativeSettings, saveNativeSettings]);

  const patchApproval = useCallback((patch: Partial<NonNullable<NonNullable<NativeSettings["tools"]>["approval"]>>) => {
    const base = latestNativeSettingsRef.current ?? nativeSettings ?? {};
    const tools = base.tools ?? {};
    void saveNativeSettings({ ...base, tools: { ...tools, approval: { ...(tools.approval ?? {}), ...patch } } });
  }, [nativeSettings, saveNativeSettings]);

  const refreshRuntimeVersion = useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/omp-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "check" }) });
      const data = (await response.json()) as OmpUpdateStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setUpdate(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  const checkForAppUpdate = useCallback(async (force = false) => {
    if (appUpdatesDisabled) return;
    setCheckingAppUpdate(true);
    setAppUpdateMessage(null);
    try {
      await onRefreshAppUpdate(force);
    } catch (error) {
      setAppUpdateMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingAppUpdate(false);
    }
  }, [appUpdatesDisabled, onRefreshAppUpdate]);

  const restartSessions = useCallback(async () => {
    setRestarting(true);
    try {
      const response = await fetch("/api/omp-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restart" }) });
      const data = (await response.json()) as { error?: string; code?: string; sessionsRestarted?: number };
      if (!response.ok || data.error) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setMessage(t("settingsConfig.restartSuccess", { count: data.sessionsRestarted ?? 0 }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRestarting(false);
    }
  }, [t]);


  const currentTab = activeTab;
  const nativeSettingsRequired = currentTab === "extensions";
  useEffect(() => {
    if (currentTab === "system") {
      void fetchWindowsServiceStatus();
    }
  }, [currentTab, fetchWindowsServiceStatus]);

  useEffect(() => {
    if (currentTab !== "system" || hasCheckedUpdates) return;
    setHasCheckedUpdates(true);
    void refreshRuntimeVersion();
  }, [currentTab, hasCheckedUpdates, refreshRuntimeVersion]);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchActive = trimmedQuery.length > 0;

  useEffect(() => {
    if (searchActive || currentTab !== "extensions" || nativeSettingsLoading) return;
    if (highlightId === "mcp-servers" || highlightId === "skills-library") {
      document.getElementById(`settings-${highlightId}`)?.scrollIntoView({ block: "start" });
    }
  }, [highlightId, currentTab, nativeSettingsLoading, searchActive]);

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!trimmedQuery) return [];
    const results: SearchResult[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      const labelKeyCat = `settingsTabs.${category.id}.label`;
      const descKeyCat = `settingsTabs.${category.id}.description`;
      const trLabelCat = t(labelKeyCat);
      const trDescCat = t(descKeyCat);
      const localizedLabel = trLabelCat !== labelKeyCat ? trLabelCat : category.label;
      const localizedDesc = trDescCat !== descKeyCat ? trDescCat : category.description;
      const haystack = `${localizedLabel} ${localizedDesc} ${category.label} ${category.description}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: `tab-${category.id}`, kind: "category", tab: category.id, label: localizedLabel, description: localizedDesc });
      }
    }
    for (const setting of SETTING_INDEX) {
      const trLabel = t(setting.labelKey);
      const trDesc = t(setting.descKey);
      const trSection = t(setting.sectionKey);
      const localizedLabel = trLabel !== setting.labelKey ? trLabel : setting.fallbackLabel;
      const localizedDesc = trDesc !== setting.descKey ? trDesc : setting.fallbackDesc;
      const localizedSection = trSection !== setting.sectionKey ? trSection : setting.fallbackSection;
      const haystack = `${localizedLabel} ${localizedDesc} ${localizedSection} ${setting.fallbackLabel} ${setting.fallbackDesc} ${setting.fallbackSection}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: setting.id, kind: "setting", tab: setting.tab, appearanceTab: setting.appearanceTab, generalTab: setting.generalTab, providersTab: setting.providersTab, agentTab: setting.agentTab, label: localizedLabel, description: localizedDesc, scope: setting.scope, section: localizedSection });
      }
    }
    return results;
  }, [trimmedQuery, t]);

  const openSearchResult = useCallback((result: SearchResult) => {
    startTransition(() => {
      if (result.tab === "appearance") onAppearanceTabChange(result.appearanceTab ?? "display");
      if (result.tab === "general") setGeneralTab(result.generalTab ?? (result.kind === "category" ? "layout" : "behavior"));
      if (result.tab === "providers") setProvidersTab(result.providersTab ?? "connected");
      if (result.tab === "agents") setAgentTab(result.agentTab ?? "instructions");
      onSelectTab(result.tab);
    });
    setHighlightId(result.kind === "setting" ? result.id : null);
    setSearchQuery("");
  }, [onSelectTab, onAppearanceTabChange]);

  const handleSelectTab = useCallback((tab: SettingsTab) => {
    startTransition(() => onSelectTab(tab));
  }, [onSelectTab]);

  const contentStyle = useMemo(() => ({
    flex: 1 as const,
    minHeight: 0,
    display: "flex" as const,
    flexDirection: "column" as const,
    overflowY: "auto" as const,
    background: "var(--bg)" as const,
    opacity: isPending ? 0.92 : 1,
    transition: isPending ? "opacity 80ms ease-out" : "opacity 120ms ease-out",
  }), [isPending]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" && (target as HTMLInputElement).value) return;
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="settings-view" role="region" aria-label={t("settingsConfig.title")}>
      <header className="settings-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="settings-back"
            onClick={onClose}
            aria-label={t("settingsConfig.back")}
            title={`${t("settingsConfig.back")} (Esc)`}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            <span>{t("settingsConfig.back")}</span>
          </button>
          <span style={{ width: 1, height: 18, background: "var(--border)", opacity: 0.8 }} aria-hidden="true" />
          <h1 style={{ fontSize: "var(--text-lg)", margin: 0, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--text)" }}>
            {t("settingsConfig.title")}
          </h1>
          {nativeSavesInFlight > 0 ? (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--accent)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <RefreshCw size={11} className="spin" aria-hidden="true" /> {t("settingsConfig.saving")}
            </span>
          ) : nativeSettingsLoading ? (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)" }}>
              {t("appShell.loading")}
            </span>
          ) : nativeSettingsError ? null : (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)" }}>
              {t("settingsConfig.autoSaved")}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, maxWidth: 380, justifyContent: "flex-end" }}>
          <div style={{ position: "relative", width: "100%", maxWidth: 280 }}>
            <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
            <input
              type="text"
              aria-label={t("settingsConfig.searchPlaceholder")}
              placeholder={t("settingsConfig.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (searchQuery) {
                    e.stopPropagation();
                    setSearchQuery("");
                    setHighlightId(null);
                  } else {
                    onClose();
                  }
                  (e.target as HTMLInputElement).blur();
                }
              }}
              style={{ width: "100%", height: "var(--row-height-compact)", padding: "0 28px 0 30px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: "var(--text-sm)", outline: "none" }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => { setSearchQuery(""); setHighlightId(null); }}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex", alignItems: "center", justifyContent: "center" }}
                aria-label="Clear search"
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settingsConfig.closeSettings")}
            title={`${t("settingsConfig.closeSettings")} (Esc)`}
            className="settings-close-btn ui-focus-ring"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="settings-body">
        {searchActive ? (
          <SearchResultsList results={searchResults} query={searchQuery.trim()} onSelect={openSearchResult} />
        ) : (
          <SettingsHighlightContext.Provider value={highlightId}>
            <SettingsTabs active={currentTab} onSelect={handleSelectTab} workspaceReady={workspaceReady} layout={isMobile ? "horizontal" : "vertical"} attentionTabs={attentionTabs} />

            <div className="settings-content" style={contentStyle}>
            {nativeSettingsRequired && nativeSettingsLoading ? (
              <div className="settings-loading-state" role="status" aria-live="polite" aria-busy="true" aria-label={t("appShell.loading")}>
                <div className="skeleton settings-loading-row" />
                <div className="skeleton settings-loading-row" />
                <div className="skeleton settings-loading-row" />
              </div>
            ) : (
              <>
            {nativeSettingsRequired && nativeSettingsError && (
              <div style={{ margin: 16 }}>
                <Alert variant="error" description={nativeSettingsError} onDismiss={() => setNativeSettingsError(null)} />
              </div>
            )}
            {nativeSettingsRequired && nativeSettingsError && (
              <div style={{ margin: "0 16px 16px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => void loadNativeSettings()}
                  style={{ minHeight: "var(--control-height)", padding: "5px var(--control-padding-inline)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600 }}
                >
                  {t("chatWindow.retry")}
                </button>
              </div>
            )}

            {currentTab === "appearance" && (
              <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16, width: "100%", maxWidth: 1080 }}>
                <div>
                  <h2 className="display-serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600, margin: 0, color: "var(--text)" }}>{t("settingsTabs.appearance.label")}</h2>
                </div>
                <SettingsSubTabs
                  id="appearance" label={t("settingsTabs.appearance.label")}
                  tabs={APPEARANCE_TABS} value={appearanceTab}
                  onChange={(tab) => { setHighlightId(null); onAppearanceTabChange(tab); }}
                  labelFor={(tab) => t(`settingsConfig.appearance.${tab}`)}
                />
                <div role="tabpanel" id={`appearance-panel-${appearanceTab}`} aria-labelledby={`appearance-tab-${appearanceTab}`} style={{ minWidth: 0 }}>
                  {appearanceTab === "display" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <NativeSetting searchId="theme" label={t("settingsConfig.theme")} scope="UI">
                        <Select
                          style={selectStyle}
                          value={themePreference}
                          onChange={(value) => setTheme(value as ThemePreference)}
                          options={[
                            { value: "system", label: t("appShell.themeSystem") },
                            ...ALL_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
                          ]}
                        />
                      </NativeSetting>
                      <NativeSetting searchId="chat-font-size" label={t("settingsConfig.chatFontSize")} scope="UI">
                        <Select
                          style={selectStyle}
                          value={fontSize}
                          onChange={(nextValue) => setFontSize(nextValue as FontSizePreference)}
                          options={[
                            { value: "sm", label: t("settingsConfig.fontSizeSmall") },
                            { value: "md", label: t("settingsConfig.fontSizeMedium") },
                            { value: "lg", label: t("settingsConfig.fontSizeLarge") },
                            { value: "xl", label: t("settingsConfig.fontSizeXLarge") },
                          ]}
                        />
                      </NativeSetting>
                      <NativeSetting searchId="ui-scale" label={t("settingsConfig.uiScale")} scope="UI">
                        <Select
                          style={selectStyle}
                          value={uiScale}
                          onChange={(nextValue) => setUiScale(nextValue as UiScalePreference)}
                          options={[
                            { value: "compact", label: t("settingsConfig.uiScaleCompact") },
                            { value: "standard", label: t("settingsConfig.uiScaleStandard") },
                            { value: "comfortable", label: t("settingsConfig.uiScaleComfortable") },
                            { value: "large", label: t("settingsConfig.uiScaleLarge") },
                          ]}
                        />
                      </NativeSetting>
                    </div>
                  )}
                  {appearanceTab === "wallpapers" && <WallpapersConfig />}
                  {appearanceTab === "pets" && <PetsConfig />}
                  {appearanceTab === "motion" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <NativeSetting searchId="whale-tail" label={t("settingsConfig.whaleTail")} scope="UI">
                        <WhaleTailPicker
                          value={whaleTail}
                          labelFor={(motion) => t(`settingsConfig.whaleTail.${motion}`)}
                          onChange={(next) => {
                            setWhaleTailMotion(next);
                            setWhaleTail(next);
                          }}
                        />
                      </NativeSetting>
                    </div>
                  )}
                </div>
              </div>
            )}
            {currentTab === "general" && (
              <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16, width: "100%", maxWidth: 1080 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.interfaceBehavior")}</h2>
                </div>
                <SettingsSubTabs
                  id="general" label={t("settingsTabs.general.label")}
                  tabs={GENERAL_TABS} value={generalTab}
                  onChange={(tab) => { setHighlightId(null); setGeneralTab(tab); }}
                  labelFor={(tab) => t(`settingsConfig.general.${tab}`)}
                />
                {generalTab === "layout" && (
                <div role="tabpanel" id="general-panel-layout" aria-labelledby="general-tab-layout" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NativeSetting searchId="keep-tool-calls-collapsed" label={t("settingsConfig.keepToolCallsCollapsed")} scope="UI">
                    <ToggleSwitch checked={toolCallsDefaultCollapsed} onChange={onToolCallsDefaultCollapsedChange} />
                  </NativeSetting>
                  <NativeSetting searchId="hide-compacted-history" label={t("settingsConfig.hideCompactedHistory")} description={t("settingsConfig.hideCompactedHistoryDesc")} scope="UI">
                    <ToggleSwitch checked={hideCompactedHistory} onChange={(hide) => { setHideCompactedHistory(hide); setHideCompactedHistoryState(hide); }} />
                  </NativeSetting>
                  <NativeSetting searchId="provider-usage" label={t("settingsConfig.providerUsage")} scope="UI">
                    <ToggleSwitch checked={providerUsageVisible} onChange={onProviderUsageVisibleChange} />
                  </NativeSetting>
                </div>
                )}
                {generalTab === "behavior" && (
                <div role="tabpanel" id="general-panel-behavior" aria-labelledby="general-tab-behavior" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NativeSetting searchId="scope-native-select-all" label={t("settingsConfig.scopeNativeSelectAll")} description={t("settingsHint.scopeNativeSelectAll")} scope="UI">
                    <ToggleSwitch checked={scopeNativeSelectAll} onChange={onScopeNativeSelectAllChange} />
                  </NativeSetting>
                  <NativeSetting searchId="open-url-automatically" label={t("settingsConfig.openUrlAutomatically")} scope="UI">
                    <ToggleSwitch checked={openUrlAutomatically} onChange={onOpenUrlAutomaticallyChange} />
                  </NativeSetting>
                  <NativeSetting searchId="open-file-automatically" label={t("settingsConfig.openFileAutomatically")} scope="UI">
                    <ToggleSwitch checked={openFileAutomatically} onChange={onOpenFileAutomaticallyChange} />
                  </NativeSetting>
                  <NativeSetting searchId="completion-sound" label={t("settingsConfig.completionSound")} scope="UI">
                    <ToggleSwitch
                      checked={soundEnabled}
                      onChange={(next) => {
                        setSoundEnabled(next);
                        try { localStorage.setItem("omp-sound-enabled", String(next)); } catch { /* storage fallback */ }
                        window.dispatchEvent(new CustomEvent("omp-sound-pref-change", { detail: next }));
                      }}
                    />
                  </NativeSetting>
                  <NativeSetting
                    searchId="tts-autoplay"
                    label={t("settingsConfig.ttsAutoplay")}
                    description={ttsSupported ? undefined : t("settingsConfig.ttsNotSupported")}
                    scope="UI"
                  >
                    <ToggleSwitch
                      checked={ttsSupported ? ttsAutoPlay : false}
                      disabled={!ttsSupported}
                      onChange={setTtsAutoPlay}
                    />
                  </NativeSetting>
                  <NativeSetting
                    searchId="tts-voice"
                    label={t("settingsConfig.ttsVoice")}
                    description={ttsSupported ? undefined : t("settingsConfig.ttsNotSupported")}
                    scope="UI"
                  >
                    <Select
                      style={selectStyle}
                      value={ttsVoiceURI || ""}
                      disabled={!ttsSupported || ttsVoices.length === 0}
                      onChange={(nextValue) => setTtsVoiceURI(nextValue || null)}
                      options={[
                        { value: "", label: t("settingsConfig.defaultVoice") || "Default system voice" },
                        ...ttsVoices.map((v) => (
                        ({ value: v.voiceURI, label: <>{v.name} ({v.lang})</> })
                      )),
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="message-during-active-run" label={t("settingsConfig.messageDuringActiveRun")} description={t("settingsHint.messageDuringActiveRun")} scope="UI">
                    <Select
                      style={selectStyle}
                      value={submitBehavior}
                      onChange={(nextValue) => {
                        const next = nextValue as SubmitDuringRunBehavior;
                        setSubmitDuringRunBehavior(next);
                        setSubmitBehavior(next);
                      }}
                      options={[
                        { value: "steer", label: t("settingsConfig.steerCurrentRun") },
                        { value: "queue", label: t("settingsConfig.queueFollowUp") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="word-completion" label={t("settingsConfig.wordCompletion")} description={t("settingsHint.wordCompletion")} scope="UI">
                    <Select
                      style={selectStyle}
                      value={wordCompletion}
                      onChange={(nextValue) => {
                        const next = nextValue as WordCompletionMode;
                        setWordCompletionMode(next);
                        setWordCompletion(next);
                      }}
                      options={[
                        { value: "auto", label: t("settingsConfig.wordCompletionAuto") },
                        { value: "on", label: t("settingsConfig.wordCompletionOn") },
                        { value: "off", label: t("settingsConfig.wordCompletionOff") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="terminal-command" label={t("settingsConfig.terminalCommand")} description={t("settingsHint.terminalCommand")} scope="UI">
                    <Select
                      style={selectStyle}
                      value={terminalCommandMode}
                      onChange={(nextValue) => {
                        const next = nextValue as TerminalCommandMode;
                        setTerminalCommandMode(next);
                        setTerminalCommandModeState(next);
                      }}
                      options={[
                        { value: "auto", label: t("settingsConfig.terminalCommandAuto") },
                        { value: "local", label: t("settingsConfig.terminalCommandLocal") },
                        { value: "ssh", label: t("settingsConfig.terminalCommandSsh") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="terminal-command-ssh-host" label={t("settingsConfig.terminalCommandSshHost")} description={t("settingsHint.terminalCommandSshHost")} scope="UI">
                    <input
                      type="text"
                      value={terminalSshHost}
                      placeholder={typeof window === "undefined" ? "" : window.location.hostname}
                      spellCheck={false}
                      autoCapitalize="off"
                      aria-label={t("settingsConfig.terminalCommandSshHost")}
                      onChange={(event) => setTerminalSshHostState(event.target.value)}
                      onBlur={() => setTerminalSshHost(terminalSshHost)}
                      style={{ width: 180, maxWidth: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
                    />
                  </NativeSetting>
                </div>
                )}
                {generalTab === "shortcuts" && (
                  <div role="tabpanel" id="general-panel-shortcuts" aria-labelledby="general-tab-shortcuts" style={{ minWidth: 0 }}>
                    <KeyboardShortcutsConfig />
                  </div>
                )}
              </div>
            )}


            {currentTab === "providers" && (
              <div role="tabpanel" id="settings-panel-providers" aria-labelledby="settings-tab-providers" className="settings-panel-inner" style={{ width: "100%", maxWidth: 1080, minHeight: 0, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
                <div style={{ marginBottom: 12 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsTabs.providers.label")}</h2>
                </div>
                <ModelsConfig
                  embedded onClose={onClose} onSaved={onModelsSaved}
                  subTab={providersTab}
                  onSubTabChange={(tab) => { setHighlightId(null); setProvidersTab(tab); }}
                  defaultsPanel={
                    <section aria-labelledby="model-defaults-heading" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <h3 id="model-defaults-heading" className="display-serif" style={{ fontSize: 19, margin: 0 }}>{t("settingsConfig.modelDefaults")}</h3>
                      {nativeSettingsLoading ? <SettingsTabLoading /> : nativeSettingsError ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <Alert variant="error" description={nativeSettingsError} />
                          <button type="button" className="settings-back" onClick={() => void loadNativeSettings()}>{t("chatWindow.retry")}</button>
                        </div>
                      ) : (
                        <>
                          <NativeSetting searchId="reasoning" label={t("settingsConfig.reasoning")} scope="Native OMP">
                            <Select
                              style={selectStyle}
                              value={nativeSettings?.defaultThinkingLevel ?? "high"}
                              onChange={(nextValue) => patchSettings({ defaultThinkingLevel: nextValue as NativeSettings["defaultThinkingLevel"] })}
                              options={["auto", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({ value: level, label: level }))}
                            />
                          </NativeSetting>
                          <NativeSetting searchId="verbosity" label={t("settingsConfig.verbosity")} scope="Native OMP">
                            <Select
                              style={selectStyle}
                              value={nativeSettings?.textVerbosity ?? "medium"}
                              onChange={(nextValue) => patchSettings({ textVerbosity: nextValue as NativeSettings["textVerbosity"] })}
                              options={[
                                { value: "low", label: t("settingsConfig.verbosityLow") },
                                { value: "medium", label: t("settingsConfig.verbosityMedium") },
                                { value: "high", label: t("settingsConfig.verbosityHigh") },
                              ]}
                            />
                          </NativeSetting>
                          <NativeSetting searchId="personality" label={t("settingsConfig.personality")} scope="Native OMP">
                            <Select
                              style={selectStyle}
                              value={nativeSettings?.personality ?? "default"}
                              onChange={(nextValue) => patchSettings({ personality: nextValue as NativeSettings["personality"] })}
                              options={[
                                { value: "default", label: t("settingsConfig.personalityDefault") },
                                { value: "friendly", label: t("settingsConfig.personalityFriendly") },
                                { value: "pragmatic", label: t("settingsConfig.personalityPragmatic") },
                                { value: "none", label: t("settingsConfig.personalityNone") },
                              ]}
                            />
                          </NativeSetting>
                          <NativeSetting searchId="thinking-blocks" label={t("settingsConfig.thinkingBlocks")} scope="Native OMP">
                            <ToggleSwitch checked={nativeSettings?.hideThinkingBlock ?? false} onChange={(checked) => patchSettings({ hideThinkingBlock: checked })} />
                          </NativeSetting>
                          <NativeSetting searchId="external-thinking" label={t("settingsConfig.externalThinking")} description={t("settingsHint.externalThinking")} scope="Native OMP">
                            <ToggleSwitch checked={nativeSettings?.externalThinking ?? false} onChange={(checked) => patchSettings({ externalThinking: checked })} />
                          </NativeSetting>
                        </>
                      )}
                    </section>
                  }
                />
              </div>
            )}

            {/* USAGE & ANALYTICS TAB */}
            {currentTab === "usage" && (
              <div
                role="tabpanel"
                id="settings-panel-usage"
                aria-labelledby="settings-tab-usage"
                className="settings-panel-inner"
                style={{
                  display: currentTab === "usage" ? "flex" : "none",
                  width: "100%",
                  maxWidth: 940,
                  minHeight: 0,
                  flexDirection: "column",
                  padding: isMobile ? "16px 14px 32px" : "32px 24px 64px",
                }}
              >
                <UsageConfig />
              </div>
            )}


            {/* EXTENSIONS & SKILLS */}
            {currentTab === "extensions" && (
              <div role="tabpanel" id="settings-panel-extensions" aria-labelledby="settings-tab-extensions" className="settings-panel-inner" style={{ display: "flex", width: "100%", maxWidth: 940, minHeight: 0, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.extensionsSkills")}</h2>
                </div>
                <NativeSetting searchId="generate-image" label={t("settingsConfig.generateImage")} description={t("settingsHint.generateImage")} scope="Native OMP">
                  <ToggleSwitch
                    checked={nativeSettings?.generate_image?.enabled ?? true}
                    onChange={(checked) => patchSection("generate_image", { enabled: checked })}
                  />
                </NativeSetting>
                <section id="settings-mcp-servers" aria-labelledby="settings-mcp-heading" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", borderTop: "1px solid var(--border)", paddingTop: 18 }}>
                  <h3 id="settings-mcp-heading" style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>{t("settingsConfig.mcpServers")}</h3>
                  {cwd && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                      <NativeSetting searchId="load-project-mcp-servers" label={t("settingsConfig.loadProjectMcp")} scope="Native OMP">
                        <ToggleSwitch
                          checked={nativeSettings?.mcp?.enableProjectConfig ?? true}
                          onChange={(checked) => patchSection("mcp", { enableProjectConfig: checked })}
                        />
                      </NativeSetting>
                      <NativeSetting searchId="render-mcp-markdown" label={t("settingsConfig.renderMcpMarkdown")} scope="Native OMP">
                        <ToggleSwitch
                          checked={nativeSettings?.mcp?.renderMarkdownResults ?? true}
                          onChange={(checked) => patchSection("mcp", { renderMarkdownResults: checked })}
                        />
                      </NativeSetting>
                      <NativeSetting searchId="mcp-resource-updates" label={t("settingsConfig.mcpResourceUpdates")} scope="Native OMP">
                        <ToggleSwitch
                          checked={nativeSettings?.mcp?.notifications ?? false}
                          onChange={(checked) => patchSection("mcp", { notifications: checked })}
                        />
                      </NativeSetting>
                    </div>
                  )}
                  <McpConfig cwd={cwd} sessionId={sessionId} />
                  {!cwd && <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>{t("settingsConfig.selectWorkspaceForMcp")}</p>}
                </section>
                <section id="settings-skills-library" aria-labelledby="settings-skills-heading" style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", minWidth: 0, borderTop: "1px solid var(--border)", paddingTop: 18 }}>
                  <h3 id="settings-skills-heading" style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>{t("settingsConfig.skillsLibrary")}</h3>
                  {cwd ? (
                    <div style={{ display: "flex", flexDirection: "column", minHeight: isMobile ? undefined : 600, minWidth: 0 }}>
                      <SkillsConfig key={cwd} embedded cwd={cwd} onClose={onClose} />
                    </div>
                  ) : (
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>{t("settingsConfig.selectWorkspaceForSkills")}</p>
                  )}
                </section>
              </div>
            )}

            {currentTab === "agents" && (
              <div role="tabpanel" id="settings-panel-agents" aria-labelledby="settings-tab-agents" className="settings-panel-inner" style={{ width: "100%", maxWidth: 1080, padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)" }}>{t("settingsTabs.agents.label")}</h2>
                </div>
                <SettingsSubTabs
                  id="agents" label={t("settingsTabs.agents.label")}
                  tabs={AGENT_TABS} value={agentTab}
                  onChange={(tab) => { setHighlightId(null); setAgentTab(tab); }}
                  labelFor={(tab) => t(`settingsConfig.agents.${tab}`)}
                />
                <div role="tabpanel" id="agents-panel-instructions" aria-labelledby="agents-tab-instructions" hidden={agentTab !== "instructions"} style={{ display: agentTab === "instructions" ? "block" : "none", minWidth: 0 }}>
                  <AgentInstructionsConfig />
                </div>
                <div role="tabpanel" id="agents-panel-subagents" aria-labelledby="agents-tab-subagents" hidden={agentTab !== "subagents"} style={{ display: agentTab === "subagents" ? "block" : "none", minWidth: 0 }}>
                  <SubagentAccessSetting />
                  {nativeSettingsLoading ? <SettingsTabLoading /> : nativeSettingsError ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                      <Alert variant="error" description={nativeSettingsError} />
                      <button type="button" className="settings-back" onClick={() => void loadNativeSettings()}>{t("chatWindow.retry")}</button>
                    </div>
                  ) : (
                    <>
                      <NativeSetting searchId="subagents-depth" label={t("settingsConfig.subagentsDepth")} description={t("settingsHint.subagentsDepth")} scope="Native OMP">
                        <NativeIntegerInput value={nativeSettings?.task?.maxRecursionDepth ?? 2} minimum={-1}
                          onCommit={(maxRecursionDepth) => patchSection("task", { maxRecursionDepth })} />
                      </NativeSetting>
                      <NativeSetting searchId="subagents-concurrency" label={t("settingsConfig.subagentsConcurrency")} description={t("settingsHint.subagentsConcurrency")} scope="Native OMP">
                        <NativeIntegerInput value={nativeSettings?.task?.maxConcurrency ?? 32} minimum={0}
                          onCommit={(maxConcurrency) => patchSection("task", { maxConcurrency })} />
                      </NativeSetting>
                    </>
                  )}
                  <AgentsConfig cwd={cwd} />
                </div>
                {(agentTab === "runtime" || agentTab === "approvals") && (
                  <div role="tabpanel" id={`agents-panel-${agentTab}`} aria-labelledby={`agents-tab-${agentTab}`} style={{ minWidth: 0 }}>
                    {nativeSettingsLoading ? <SettingsTabLoading /> : nativeSettingsError ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <Alert variant="error" description={nativeSettingsError} />
                        <button type="button" className="settings-back" onClick={() => void loadNativeSettings()}>{t("chatWindow.retry")}</button>
                      </div>
                    ) : (
                      <>
                        {agentTab === "runtime" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {/* Context Compaction Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 18, width: "100%" }}>
                  <div className="settings-section-title" style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{t("settingsConfig.contextCompaction")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, width: "100%" }}>
                    <NativeSetting searchId="automatic-compaction" label={t("settingsConfig.automaticCompaction")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.enabled ?? true}
                        onChange={(checked) => patchSection("compaction", { enabled: checked })}
                      />
                    </NativeSetting>
                    <DependentSettings active={nativeSettings?.compaction?.enabled ?? true}>
                    <NativeSetting searchId="continue-after-compaction" label={t("settingsConfig.continueAfterCompaction")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.autoContinue ?? true}
                        onChange={(checked) => patchSection("compaction", { autoContinue: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="compact-mid-turn" label={t("settingsConfig.compactMidTurn")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.midTurnEnabled ?? true}
                        onChange={(checked) => patchSection("compaction", { midTurnEnabled: checked })}
                      />
                    </NativeSetting>
                    </DependentSettings>
                    <NativeSetting searchId="maintenance-strategy" label={t("settingsConfig.maintenanceStrategy")} scope="Native OMP">
                      <Select
                        style={selectStyle}
                        value={nativeSettings?.compaction?.strategy ?? "snapcompact"}
                        onChange={(nextValue) => patchSection("compaction", { strategy: nextValue as NonNullable<NativeSettings["compaction"]>["strategy"] })}
                        options={[
                          { value: "snapcompact", label: t("settingsConfig.strategySnapcompact") },
                          { value: "handoff", label: t("settingsConfig.strategyHandoff") },
                          { value: "context-full", label: t("settingsConfig.strategyContextFull") },
                          { value: "shake", label: t("settingsConfig.strategyShake") },
                          { value: "off", label: t("settingsConfig.strategyOff") },
                        ]}
                      />
                    </NativeSetting>
                  </div>
                </section>

                {/* Memory & Auto-Learn Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 18, width: "100%" }}>
                  <div className="settings-section-title" style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{t("settingsConfig.memoryAutoLearn")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, width: "100%" }}>
                    <NativeSetting searchId="memory-backend" label={t("settingsConfig.memoryBackend")} scope="Native OMP">
                      <Select
                        style={selectStyle}
                        value={nativeSettings?.memory?.backend ?? "mnemopi"}
                        onChange={(nextValue) => patchSection("memory", { backend: nextValue as NonNullable<NativeSettings["memory"]>["backend"] })}
                        options={[
                          { value: "off", label: t("settingsConfig.memoryBackendOff") },
                          { value: "local", label: t("settingsConfig.memoryBackendLocal") },
                          { value: "mnemopi", label: t("settingsConfig.memoryBackendMnemopi") },
                          { value: "hindsight", label: t("settingsConfig.memoryBackendHindsight") },
                        ]}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="enable-auto-learn" label={t("settingsConfig.enableAutoLearn")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.autolearn?.enabled ?? true}
                        onChange={(checked) => patchSection("autolearn", { enabled: checked })}
                      />
                    </NativeSetting>
                    <DependentSettings active={nativeSettings?.autolearn?.enabled ?? true}>
                    <NativeSetting searchId="private-capture-turn" label={t("settingsConfig.privateCaptureTurn")} description={t("settingsHint.privateCaptureTurn")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.autolearn?.autoContinue ?? true}
                        onChange={(checked) => patchSection("autolearn", { autoContinue: checked })}
                      />
                    </NativeSetting>
                    </DependentSettings>
                    <DependentSettings active={(nativeSettings?.memory?.backend ?? "mnemopi") === "mnemopi"} label={t("settingsConfig.memoryBackendMnemopi")}>
                    <NativeSetting searchId="memory-scope" label={t("settingsConfig.memoryScope")} scope="Native OMP">
                      <Select
                        style={selectStyle}
                        value={nativeSettings?.mnemopi?.scoping ?? "per-project"}
                        onChange={(nextValue) => patchSection("mnemopi", { scoping: nextValue as NonNullable<NativeSettings["mnemopi"]>["scoping"] })}
                        options={[
                          { value: "per-project", label: t("settingsConfig.memoryScopePerProject") },
                          { value: "per-project-tagged", label: t("settingsConfig.memoryScopePerProjectTagged") },
                          { value: "global", label: t("settingsConfig.memoryScopeGlobal") },
                        ]}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="recall-on-session-start" label={t("settingsConfig.recallOnSessionStart")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.mnemopi?.autoRecall ?? true}
                        onChange={(checked) => patchSection("mnemopi", { autoRecall: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="retain-completed-turns" label={t("settingsConfig.retainCompletedTurns")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.mnemopi?.autoRetain ?? true}
                        onChange={(checked) => patchSection("mnemopi", { autoRetain: checked })}
                      />
                    </NativeSetting>
                    </DependentSettings>
                  </div>
                </section>

                {/* Retry Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 18, width: "100%" }}>
                  <div className="settings-section-title" style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{t("settingsConfig.automaticRetry")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, width: "100%" }}>
                    <NativeSetting searchId="automatic-retry" label={t("settingsConfig.retryToggle")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.retry?.enabled ?? true}
                        onChange={(checked) => patchSection("retry", { enabled: checked })}
                      />
                    </NativeSetting>
                    <DependentSettings active={nativeSettings?.retry?.enabled ?? true}>
                    <NativeSetting searchId="max-attempts" label={t("settingsConfig.maxAttempts")} scope="Native OMP">
                      <Select
                        style={selectStyle}
                        value={String(nativeSettings?.retry?.maxRetries ?? 2)}
                        onChange={(nextValue) => patchSection("retry", { maxRetries: Number(nextValue) })}
                        options={[
                          ...[0, 1, 2, 3, 4, 5].map((n) => (
                          ({ value: n, label: n })
                        )),
                        ]}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="model-fallback" label={t("settingsConfig.modelFallback")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.retry?.modelFallback ?? false}
                        onChange={(checked) => patchSection("retry", { modelFallback: checked })}
                      />
                    </NativeSetting>
                    </DependentSettings>
                  </div>
                </section>
              </div>
                        )}
                        {agentTab === "approvals" && (
              <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <h3 className="display-serif" style={{ fontSize: 19, margin: 0 }}>{t("settingsConfig.toolSafetyApprovals")}</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NativeSetting searchId="approval-mode" label={t("settingsConfig.approvalMode")} scope="Native OMP">
                    <Select
                      style={selectStyle}
                      value={nativeSettings?.tools?.approvalMode ?? "yolo"}
                      onChange={(nextValue) => patchSection("tools", { approvalMode: nextValue as "always-ask" | "write" | "yolo" })}
                      options={[
                        { value: "always-ask", label: t("settingsConfig.alwaysAsk") },
                        { value: "write", label: t("settingsConfig.allowWrites") },
                        { value: "yolo", label: t("settingsConfig.autoApproveYolo") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="bash-override" label={t("settingsConfig.bashOverride")} scope="Native OMP">
                    <Select
                      style={selectStyle}
                      value={nativeSettings?.tools?.approval?.bash ?? "prompt"}
                      onChange={(nextValue) => patchApproval({ bash: nextValue as "allow" | "prompt" | "deny" })}
                      options={[
                        { value: "allow", label: t("settingsConfig.allow") },
                        { value: "prompt", label: t("settingsConfig.alwaysAsk") },
                        { value: "deny", label: t("settingsConfig.deny") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="extension-tool-requests" label={t("settingsConfig.extensionToolRequests")} scope="Native OMP">
                    <Select
                      style={selectStyle}
                      value={nativeSettings?.tools?.approval?.extension ?? "prompt"}
                      onChange={(nextValue) => patchApproval({ extension: nextValue as "allow" | "prompt" })}
                      options={[
                        { value: "prompt", label: t("settingsConfig.askEveryTime") },
                        { value: "allow", label: t("settingsConfig.autoApprove") },
                      ]}
                    />
                  </NativeSetting>
                </div>
              </section>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* SYSTEM & UPDATES TAB */}
            {currentTab === "system" && (
              <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.systemUpdates")}</h2>
                </div>

                <AutoResumeSessionsSetting />
                <SudoAutoAnswerSetting />

                {/* ompweb app update card */}
                <section style={{ padding: 14, border: appUpdateIsAvailable ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("settingsConfig.appLabel")}</span>
                        {appUpdateIsAvailable && (
                          <span
                            role="status"
                            aria-label={t("settingsTabs.updateAvailable")}
                            title={t("settingsTabs.updateAvailable")}
                            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}
                          />
                        )}
                      </div>
                      <div style={{ marginTop: 4, color: appUpdateIsAvailable ? "var(--accent)" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {appUpdatesDisabled ? t("settingsConfig.updatesDisabled") : checkingAppUpdate ? t("settingsConfig.checkingUpdates") : appUpdate?.updateAvailable ? t("appShell.updateVersion", { current: appUpdate.currentVersion ?? "?", available: appUpdate.availableVersion ?? "?" }) : appUpdate?.currentVersion ? t("settingsConfig.upToDate", { version: appUpdate.currentVersion }) : t("settingsConfig.versionUnavailable")}
                      </div>
                    </div>
                    <button type="button" onClick={() => void checkForAppUpdate(true)} disabled={checkingAppUpdate || appUpdatesDisabled} aria-label={t("settingsConfig.checkAppUpdates")} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: checkingAppUpdate || appUpdatesDisabled ? "not-allowed" : "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <RefreshCw size={13} aria-hidden="true" /> {t("settingsConfig.refresh")}
                    </button>
                  </div>
                  {appUpdate?.updateAvailable && (
                    <div style={{ marginTop: 6, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 8 }}>
                      {appUpdate.selfUpdateSupported ? (
                        <button
                          type="button"
                          onClick={onRequestAppUpdate}
                          style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                        >
                          <Download size={13} aria-hidden="true" />
                          {t("settingsConfig.appUpdateAction")}
                        </button>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {t("settingsConfig.runAppUpdateCommand")}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", wordBreak: "break-all" }}>{appUpdate.updateCommand || "npm install -g @kahme247/ompweb"}</code>
                            <button
                              type="button"
                              onClick={() => {
                                void copyText(appUpdate.updateCommand || "npm install -g @kahme247/ompweb")
                                  .then(() => toast.success(t("appShell.commandCopied")))
                                  .catch(() => toast.error(t("appShell.commandCopyFailed")));
                              }}
                              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
                            >
                              <Copy size={12} aria-hidden="true" /> {t("appShell.copyCommand")}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {appUpdateMessage && <Alert variant={appUpdateMessage.toLowerCase().includes("fail") || appUpdateMessage.toLowerCase().includes("error") ? "error" : "info"} description={appUpdateMessage} onDismiss={() => setAppUpdateMessage(null)} />}
                </section>

                {/* Source-managed OMP runtime */}
                <section style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("settingsConfig.ompLabel")}</span>
                      </div>
                      <div style={{ marginTop: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {checking || (!hasCheckedUpdates && !update) ? t("settingsConfig.readingRuntimeVersion") : update?.currentVersion ?? t("settingsConfig.versionUnavailable")}
                      </div>
                    </div>
                    <button type="button" onClick={() => void refreshRuntimeVersion()} disabled={checking} aria-label={t("settingsConfig.refreshRuntimeVersion")} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: checking ? "not-allowed" : "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <RefreshCw size={13} aria-hidden="true" /> {t("settingsConfig.refresh")}
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("settingsConfig.ompSourceManaged")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      onClick={() => void restartSessions()}
                      disabled={restarting}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: restarting ? "wait" : "pointer", fontSize: 12 }}
                    >
                      <RotateCcw size={13} aria-hidden="true" /> {restarting ? t("settingsConfig.restarting") : t("settingsConfig.restartSessions")}
                    </button>
                    <a
                      href="https://github.com/can1357/oh-my-pi/releases"
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", textDecoration: "none", fontSize: 12 }}
                    >
                      <ExternalLink size={13} aria-hidden="true" /> {t("settingsConfig.changelog")}
                    </a>
                  </div>
                  {message && <Alert variant={message.toLowerCase().includes("fail") || message.toLowerCase().includes("error") ? "error" : "info"} description={message} onDismiss={() => setMessage(null)} />}
                </section>

                {/* Windows Background Service & System Tray card (Windows only) */}
                {windowsService?.isWindows && (
                  <section style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                          <Monitor size={15} aria-hidden="true" />
                          {t("settingsConfig.windowsServiceTitle")}
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
                          {t("settingsConfig.windowsServiceDesc")}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void fetchWindowsServiceStatus()}
                        disabled={loadingWindowsService}
                        aria-label={t("settingsConfig.refresh")}
                        style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: loadingWindowsService ? "wait" : "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        <RefreshCw size={13} aria-hidden="true" /> {t("settingsConfig.refresh")}
                      </button>
                    </div>

                    {/* Status badges grid */}
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          {t("settingsConfig.windowsServiceStatus")}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: windowsService.isRunning ? "var(--accent)" : "var(--text-muted)" }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: windowsService.isRunning ? "var(--accent)" : "var(--border)" }} />
                          {windowsService.isRunning ? t("settingsConfig.windowsServiceRunning", { port: windowsService.port }) : t("settingsConfig.windowsServiceStopped")}
                        </div>
                      </div>

                      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          {t("settingsConfig.windowsServiceDesktopShortcut", { status: "" }).replace(/:\s*$/, "")}
                        </div>
                        <div style={{ fontSize: 12, color: windowsService.desktopShortcutExists ? "var(--text)" : "var(--text-muted)" }}>
                          {windowsService.desktopShortcutExists ? t("settingsConfig.windowsServicePresent") : t("settingsConfig.windowsServiceMissing")}
                        </div>
                      </div>
                    </div>

                    {/* Autostart Toggle */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{t("settingsConfig.windowsServiceAutostart")}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("settingsConfig.windowsServiceAutostartDesc")}</div>
                      </div>
                      <ToggleSwitch
                        id="windows-service-autostart-toggle"
                        checked={windowsService.autostart}
                        disabled={windowsServiceActionPending}
                        onChange={(checked) => void performWindowsServiceAction("toggle-autostart", { autostart: checked })}
                      />
                    </div>

                    {/* Action buttons toolbar */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => void performWindowsServiceAction("install", { startImmediately: false })}
                        disabled={windowsServiceActionPending}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                      >
                        <Monitor size={13} aria-hidden="true" />
                        {windowsService.isInstalled ? t("settingsConfig.windowsServiceReinstallBtn") : t("settingsConfig.windowsServiceInstallBtn")}
                      </button>

                      {windowsService.isRunning ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void performWindowsServiceAction("restart")}
                            disabled={windowsServiceActionPending}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                          >
                            <RotateCcw size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceRestartBtn")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void performWindowsServiceAction("stop")}
                            disabled={windowsServiceActionPending}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                          >
                            <Square size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceStopBtn")}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void performWindowsServiceAction("start")}
                          disabled={windowsServiceActionPending}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                        >
                          <Play size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceStartBtn")}
                        </button>
                      )}

                      {windowsService.isInstalled && (
                        <button
                          type="button"
                          onClick={() => void performWindowsServiceAction("uninstall", { cleanConfig: false })}
                          disabled={windowsServiceActionPending}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                        >
                          <Trash2 size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceUninstallBtn")}
                        </button>
                      )}
                    </div>
                  </section>
                )}
              </div>
            )}
              </>
            )}
              </div>
            </SettingsHighlightContext.Provider>
          )}
        </div>
      </div>
  );
}
