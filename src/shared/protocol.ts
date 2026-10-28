/**
 * Contract between the extension host and the webviews (chat panel and dashboard).
 *
 * The extension owns the canonical state of every session and sends it to the
 * webview: a full `state` snapshot when the webview (re)loads, then small
 * incremental messages. The webview never talks to the Claude CLI directly.
 *
 * This file must stay free of `vscode` and Node imports: it is bundled into
 * both the extension and the browser code.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** Claude Code permission modes (the CLI's names). */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

/** Labels used by the official extension's mode picker. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Edit automatically',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Claude will ask for approval before making each edit',
  acceptEdits: 'Claude will edit files without asking first',
  plan: 'Claude will explore the code and present a plan before editing',
  auto: 'Claude will approve actions that pass a safety check and pause for anything risky',
  bypassPermissions: 'Claude will not ask for approval before running potentially dangerous commands',
  dontAsk: 'Claude will deny actions that need approval instead of asking',
};

/**
 * Where a session stands, from the user's point of view.
 * - `new`: nothing sent yet, no process.
 * - `idle`: ready for the next message (a process may or may not be running).
 * - `starting`: the Claude process is launching.
 * - `running`: a turn is in progress.
 * - `waiting`: a turn is paused on the user (permission, question or plan review).
 * - `error`: the process failed or crashed; see `ChatState.error`.
 */
export type SessionStatus = 'new' | 'idle' | 'starting' | 'running' | 'waiting' | 'error';

/** Reasoning effort levels (Claude Code's /effort). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export interface ModelOption {
  /** Value passed to the CLI (`opus`, `sonnet`, `default`, a full model id…). */
  value: string;
  displayName: string;
  description?: string;
  /** Effort levels this model supports (empty/absent: no effort control). */
  efforts?: EffortLevel[];
}

/** A reusable prompt the user can insert from the composer. */
export interface PromptPreset {
  label: string;
  prompt: string;
}

/** A bookmarked message in a chat. */
export interface BookmarkView {
  /** Id of the bookmarked ChatItem. */
  itemId: string;
  /** Short text shown in the bookmark list. */
  label: string;
  kind: 'user' | 'text' | 'tool';
  createdAt: number;
}

export interface SlashCommandInfo {
  name: string; // without the leading slash
  description?: string;
  argumentHint?: string;
}

export interface ImageAttachment {
  /** e.g. image/png */
  mediaType: string;
  /** base64 without the data: prefix. May be empty when `url` is set. */
  data: string;
  name?: string;
  /**
   * Webview URL of a cached copy of the image (set by the extension for images
   * from history/tool results so they don't bloat messages). When present,
   * render <img src={url}>; otherwise use a data: URL built from mediaType + data.
   */
  url?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// ---------------------------------------------------------------------------
// Chat items (the conversation, in display order)
// ---------------------------------------------------------------------------

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  images?: ImageAttachment[];
  /** Set when the message was a slash command, e.g. "/compact keep tests". */
  command?: string;
  timestamp?: number;
  /** Sent while a turn was running and not yet picked up by Claude. */
  queued?: boolean;
}

export interface AssistantTextItem {
  kind: 'text';
  id: string;
  text: string;
  /** Transcript entry uuid of this reply (where a fork can start). */
  uuid?: string;
  /** True while the text is still streaming in. */
  streaming?: boolean;
  /** Set for messages produced inside a subagent (Task/Agent tool). */
  parentToolUseId?: string;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  /** May be empty when the model's thinking is not shown (redacted/omitted). */
  text: string;
  streaming?: boolean;
  parentToolUseId?: string;
}

export type ToolStatus =
  | 'streaming' // the model is still writing the tool input
  | 'pending' // waiting to run
  | 'waiting-permission' // a permission request for this tool is pending
  | 'running'
  | 'done'
  | 'error'
  | 'denied' // the user rejected it
  | 'interrupted';

export interface ToolResultView {
  /** Text content of the tool result (may be truncated by the extension). */
  text: string;
  isError: boolean;
  /** True when `text` was shortened before sending it to the webview. */
  truncated?: boolean;
  images?: ImageAttachment[];
}

export interface ToolItem {
  kind: 'tool';
  /** The tool_use id. */
  id: string;
  /** Tool name as the model called it: Bash, Read, Edit, Write, Grep, Glob, Task, Agent, TodoWrite, WebFetch, mcp__server__tool, … */
  name: string;
  /** Tool input (parsed JSON). While `status === 'streaming'` this may be partial or `{}`. */
  input: Record<string, unknown>;
  /** Raw partial JSON while the input is streaming (useful to preview a Bash command as it is typed). */
  partialInput?: string;
  status: ToolStatus;
  result?: ToolResultView;
  /**
   * Structured tool output from the CLI (`tool_use_result`), when available.
   * Edit/Write: { filePath, structuredPatch: [{ oldStart, oldLines, newStart, newLines, lines: string[] }], originalFile? }
   * Bash: { stdout, stderr, interrupted }
   * Read: { file: { filePath, numLines, startLine, totalLines } }
   */
  structured?: unknown;
  parentToolUseId?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SystemItem {
  kind: 'system';
  id: string;
  level: 'info' | 'warning' | 'error';
  text: string;
  /** Optional tag so the UI can style common notices. */
  tag?: 'compact' | 'interrupted' | 'retry' | 'command-output' | 'mode' | 'model' | 'resumed' | 'forked' | 'auto-continue';
  timestamp?: number;
}

/** Marks the end of a turn (the CLI's `result` message). */
export interface TurnEndItem {
  kind: 'turn-end';
  id: string;
  durationMs?: number;
  isError: boolean;
  /** Error text when isError. */
  errorText?: string;
}

export type ChatItem = UserItem | AssistantTextItem | ThinkingItem | ToolItem | SystemItem | TurnEndItem;

// ---------------------------------------------------------------------------
// Pending requests (Claude is waiting on the user)
// ---------------------------------------------------------------------------

export interface PermissionOption {
  /** Stable id to send back in the response. */
  id: string;
  /** e.g. "Yes", "Yes, and don't ask again for Bash(npm test:*) in this project", "Yes, allow all edits during this session" */
  label: string;
  kind: 'allow' | 'allow-always';
}

export interface PermissionRequestView {
  kind: 'permission';
  requestId: string;
  toolUseId?: string;
  toolName: string;
  /** Human-friendly tool name from the CLI, when it differs from toolName. */
  displayName?: string;
  /** Short title/description from the CLI (e.g. the Bash description field). */
  title?: string;
  description?: string;
  input: Record<string, unknown>;
  /** Allow options in display order (always starts with plain "Yes"). "No" is implicit. */
  options: PermissionOption[];
  blockedPath?: string;
  /** Why the CLI is asking (may be empty). Plain text, already sanitized. */
  decisionReason?: string;
  /** When true, do not pre-focus the "Yes" button (the CLI marked this ask as risky). */
  defaultToNo?: boolean;
  createdAt: number;
}

export interface QuestionOptionView {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionView {
  question: string;
  header?: string;
  options: QuestionOptionView[];
  multiSelect: boolean;
}

export interface QuestionRequestView {
  kind: 'question';
  requestId: string;
  toolUseId?: string;
  questions: QuestionView[];
  createdAt: number;
}

export interface PlanRequestView {
  kind: 'plan';
  requestId: string;
  toolUseId?: string;
  /** Markdown plan text. */
  plan: string;
  planFilePath?: string;
  createdAt: number;
}

/** One input of an MCP elicitation form (MCP's restricted JSON schema). */
export interface ElicitationField {
  name: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi';
  required: boolean;
  default?: string | number | boolean | string[];
  /** For enum / multi. */
  options?: { value: string; label: string }[];
  /** For strings: email, uri, date, date-time. */
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** An MCP server is asking the user for input (MCP elicitation). */
export interface ElicitationRequestView {
  kind: 'elicitation';
  requestId: string;
  serverName: string;
  /** Display name/title the server supplied, if any. */
  title?: string;
  /** The server's question / explanation. */
  message: string;
  /** form: fill the fields; url: open a link and confirm. */
  mode: 'form' | 'url';
  url?: string;
  fields: ElicitationField[];
  createdAt: number;
}

export type PendingRequestView = PermissionRequestView | QuestionRequestView | PlanRequestView | ElicitationRequestView;

// ---------------------------------------------------------------------------
// Chat state
// ---------------------------------------------------------------------------

export interface ContextUsageView {
  usedTokens: number;
  maxTokens?: number;
  /** 0–100 */
  percent?: number;
}

export interface ChatState {
  /** Internal key of the session in this window (stable). */
  key: string;
  sessionId?: string;
  cwd: string;
  projectName: string;
  /** Branch or worktree name, shown next to the project name. */
  branch?: string;
  isWorktree?: boolean;
  title: string;
  status: SessionStatus;
  /** Short live description while running, e.g. "Running Bash", "Editing src/app.ts", "Thinking". */
  activity?: string;
  /** Epoch ms when the current turn started (for the elapsed timer). */
  turnStartedAt?: number;
  /** Model currently in use, as a display string (e.g. "Opus 5.5"). */
  modelLabel?: string;
  /** Model value currently selected (matches ModelOption.value when known). */
  modelValue?: string;
  /** Effort in use (as reported by Claude Code), or the one chosen for the next start. */
  effort?: EffortLevel;
  /** Effort levels the current model supports (empty: the model has no effort control). */
  availableEfforts: EffortLevel[];
  permissionMode: PermissionMode;
  availableModes: PermissionMode[];
  availableModels: ModelOption[];
  slashCommands: SlashCommandInfo[];
  items: ChatItem[];
  pending: PendingRequestView[];
  /** Bookmarked messages, oldest first. */
  bookmarks: BookmarkView[];
  /** Prompt presets for the composer's presets menu (from settings). */
  promptPresets?: PromptPreset[];
  todos?: TodoItem[];
  contextUsage?: ContextUsageView;
  /** Remote Control (continue this chat from claude.ai or the Claude app). */
  remote?: RemoteControlView;
  /** Shared .env variables: which exist, which this chat uses (values never leave the extension). */
  sharedEnv?: SharedEnvView;
  /** Agents (subagents) running in this session right now, foreground and background. */
  agents?: RunningAgentView[];
  /** Set for a fork that hasn't sent its first message yet (to restore it after a reload). */
  forkFrom?: { sessionId: string; at: string; title: string };
  /** Send "continue" by itself once a usage limit that stopped this session resets. */
  autoContinue: boolean;
  /** Set while the session is stopped at a usage limit. */
  limit?: LimitStopView;
  /** Set when this session is currently running in another Claude process (another window, a terminal…). */
  liveElsewhere?: { source: string; pid: number; status?: string };
  /** Error message when status === 'error'. */
  error?: string;
  /** True when older history was left out to keep the panel fast. */
  historyTruncated?: boolean;
  /** Whether the "Bypass permissions" mode may be offered. */
  allowBypass: boolean;
  /** Whether an image can be attached (always true for now, kept for future CLIs). */
  canAttachImages: boolean;
}

/**
 * Fields of ChatState that can change without touching `items`.
 * `null` clears a field (webview messages are JSON, so `undefined` would be dropped).
 */
export type ChatStatePatch = { [K in keyof Omit<ChatState, 'items' | 'key'>]?: ChatState[K] | null };

// ---------------------------------------------------------------------------
// Messages: extension -> chat webview
// ---------------------------------------------------------------------------

export type ExtToChatMessage =
  /** Full snapshot; replaces everything the webview has. */
  | { type: 'state'; state: ChatState }
  /** Changes to top-level fields. */
  | { type: 'patch'; patch: ChatStatePatch }
  /** Insert or replace items by id. New ids are appended in the given order. */
  | { type: 'items'; items: ChatItem[] }
  /** Remove items by id (rare: e.g. a queued message that was cancelled). */
  | { type: 'remove-items'; ids: string[] }
  /** Append streamed text to an existing text/thinking item (or partialInput of a tool item). */
  | { type: 'delta'; id: string; text: string; field: 'text' | 'partialInput' }
  /** Answer to a `file-suggestions` request. */
  | { type: 'file-suggestions'; requestId: number; items: { path: string; isDirectory: boolean }[] }
  /** Put the cursor in the message box. */
  | { type: 'focus-input' }
  /** Scroll to an item and highlight it (bookmarks opened from outside the panel). */
  | { type: 'scroll-to'; itemId: string }
  /** Pre-fill the message box (e.g. from a "Send to Claude" command). */
  | { type: 'insert-text'; text: string };

// ---------------------------------------------------------------------------
// Messages: chat webview -> extension
// ---------------------------------------------------------------------------

export interface SharedEnvView {
  /** Variable names in the shared .env file. */
  available: string[];
  /** Names chosen for this chat (none by default). */
  enabled: string[];
  /** Names the running Claude has; absent while Claude isn't running in this chat. */
  active?: string[];
  /** The choice changed while Claude was busy: it applies when Claude finishes. */
  pending?: boolean;
}

export interface RemoteControlView {
  state: 'connecting' | 'on' | 'error';
  /** Link to the session on claude.ai (open it there or in the Claude app). */
  url?: string;
  error?: string;
}

/** An agent running in a session. */
export interface RunningAgentView {
  /** Agent type, e.g. "Explore" or "general-purpose". */
  type: string;
  description?: string;
  /** The Agent tool row to scroll to, when it's in the conversation. */
  itemId?: string;
  /** Runs in the background (the turn can end while it works). */
  background?: boolean;
}

/** A turn that ended because a usage limit was reached. */
export interface LimitStopView {
  /** Claude's message, e.g. "You've hit your session limit · resets 7:30am (Europe/Lisbon)". */
  message: string;
  /** Epoch ms when the limit resets, when known. */
  resetsAt?: number;
  /** Epoch ms when "continue" will be sent (only while auto-continue is on). */
  continueAt?: number;
}

export type ChatToExtMessage =
  /** Sent once the webview script has loaded; the extension answers with `state`. */
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageAttachment[] }
  /** Stop the running turn (like Esc in the terminal). */
  | { type: 'interrupt' }
  | { type: 'set-mode'; mode: PermissionMode }
  | { type: 'set-model'; model: string }
  /** 'default' returns to the model's default effort. */
  | { type: 'set-effort'; effort: EffortLevel | 'default' }
  /** Answer an MCP elicitation. content is only sent with action 'accept' in form mode. */
  | { type: 'elicitation-response'; requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> }
  /** Add or remove a bookmark on a message. */
  | { type: 'toggle-bookmark'; itemId: string }
  /** Turn "continue automatically when usage limits reset" on or off for this session. */
  | { type: 'set-auto-continue'; on: boolean }
  /** Open the shared .env file. */
  | { type: 'open-global-env' }
  /** Choose which shared .env variables this chat gets (empty = none). */
  | { type: 'set-shared-env'; names: string[] }
  /** Turn Remote Control on or off. */
  | { type: 'remote-control'; on: boolean }
  /** Start a new session with the conversation up to (and including) this reply. */
  | { type: 'fork'; itemId: string }
  /**
   * Answer a permission request.
   * optionId: one of PermissionRequestView.options[].id for allow, or 'deny'.
   * feedback: when denying, what Claude should do instead (optional).
   */
  | { type: 'permission-response'; requestId: string; optionId: string; feedback?: string }
  /** Answer an AskUserQuestion request. answers: question text -> chosen label(s), comma-separated for multi-select, or free text. */
  | { type: 'question-response'; requestId: string; answers: Record<string, string>; cancelled?: boolean }
  /** Answer an ExitPlanMode request. */
  | { type: 'plan-response'; requestId: string; decision: 'accept-auto' | 'accept-manual' | 'reject'; feedback?: string }
  /** Open a file in the editor. path may be absolute or relative to the session cwd. */
  | { type: 'open-file'; path: string; line?: number }
  /** Open VS Code's diff editor for an Edit/Write/MultiEdit tool (applied change or pending proposal). */
  | { type: 'open-diff'; toolUseId: string }
  | { type: 'open-url'; url: string }
  | { type: 'open-in-claude-extension' }
  | { type: 'new-session' }
  /** Restart after an error. */
  | { type: 'restart' }
  /** @-mention autocomplete. */
  | { type: 'file-suggestions'; requestId: number; query: string }
  | { type: 'copy'; text: string }
  /** The user saw the latest output (clears the "unread" attention state). */
  | { type: 'seen' }
  /** Ask the extension to include the full (untruncated) history. */
  | { type: 'load-full-history' };

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Where a live session runs. */
export type SessionSource = 'here' | 'other-window' | 'vscode' | 'terminal' | 'desktop' | 'sdk' | 'other';

export const SESSION_SOURCE_LABELS: Record<SessionSource, string> = {
  here: 'This window',
  'other-window': 'Another window',
  vscode: 'VS Code',
  terminal: 'Terminal',
  desktop: 'Claude app',
  sdk: 'SDK / other window',
  other: 'Other',
};

/**
 * Attention state used for sorting and badges.
 * - `needs-input`: a permission, question or plan review is pending (or the CLI reports "waiting").
 * - `done`: the turn finished and the user has not looked at it yet.
 * - `running`: a turn is in progress.
 * - `idle`: the session is open/alive but nothing is pending.
 * - `error`: the process failed.
 */
export type AttentionState = 'needs-input' | 'done' | 'running' | 'idle' | 'error';

export interface LiveSessionView {
  /** Unique key: managed session key, or `pid:<pid>` for sessions outside this window. */
  key: string;
  sessionId?: string;
  cwd: string;
  projectName: string;
  /** Registered project id when the cwd belongs to one. */
  projectId?: string;
  branch?: string;
  isWorktree?: boolean;
  title: string;
  source: SessionSource;
  managed: boolean;
  pid?: number;
  attention: AttentionState;
  /** What exactly is pending, e.g. "Permission: Bash", "Question", "Plan review", "permission prompt". */
  waitingFor?: string;
  /** One-line detail, e.g. the Bash command or the question text. */
  detail?: string;
  /** Live activity while running, e.g. "Editing src/app.ts". */
  activity?: string;
  /** Epoch ms when the current state began. */
  since: number;
  /** For managed permission requests that can be answered from the dashboard. */
  quickPermission?: { requestId: string; allowOptionId: string };
  /** It has a chat tab open in this window. */
  tabOpen?: boolean;
  /** The dashboard can close it: sessions of this window, and terminal sessions (ends their process). */
  closable?: boolean;
}

export interface UsageWindowView {
  /** 0–100, or null when unknown. */
  percent: number | null;
  /** ISO timestamp. */
  resetsAt: string | null;
}

export interface UsageView {
  fiveHour?: UsageWindowView;
  sevenDay?: UsageWindowView;
  /** Extra model-specific weekly windows (e.g. "Opus", "Fable"). */
  others: { label: string; window: UsageWindowView }[];
  fetchedAt?: number;
  error?: string;
  subscription?: string;
}

/** A session that isn't running anywhere, for the dashboard's Recent list. */
export interface RecentSessionView {
  sessionId: string;
  cwd: string;
  projectName: string;
  branch?: string;
  title: string;
  /** The latest prompt, when it says more than the title. */
  lastPrompt?: string;
  /** Epoch ms of the last change to the transcript. */
  lastActive: number;
}

export interface DashboardState {
  sessions: LiveSessionView[];
  /** Up to 10 recently worked-on sessions that aren't in `sessions`. */
  recent: RecentSessionView[];
  usage?: UsageView;
  /** Number of registered projects (for the empty state). */
  projectCount: number;
}

export type ExtToDashboardMessage =
  | { type: 'state'; state: DashboardState };

export type DashboardToExtMessage =
  | { type: 'ready' }
  | { type: 'open'; key: string }
  | { type: 'open-in-claude-extension'; key: string }
  | { type: 'open-recent'; sessionId: string; cwd: string; inClaudeExtension?: boolean }
  | { type: 'allow'; key: string; requestId: string; optionId: string }
  | { type: 'deny'; key: string; requestId: string }
  | { type: 'stop'; key: string }
  | { type: 'dismiss'; key: string }
  /** Close sessions: tabs here close, idle processes stop, terminal sessions end (after a confirm). */
  | { type: 'close'; keys: string[] }
  | { type: 'new-session' }
  | { type: 'refresh-usage' }
  | { type: 'add-project' };
