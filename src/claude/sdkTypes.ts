/**
 * The subset of the Claude Code stream-json protocol this extension uses.
 * Shapes follow @anthropic-ai/claude-agent-sdk's sdk.d.ts; everything is
 * optional/loose on purpose so newer CLIs with extra fields keep working.
 */
import type { PermissionMode } from '../shared/protocol';

// --- Anthropic content blocks ---------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data?: string;
}
export interface ToolUseBlock {
  type: 'tool_use' | 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock | { type: string; [k: string]: unknown }>;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ImageBlock | ToolResultBlock | { type: string; [k: string]: unknown };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ApiMessage {
  id?: string;
  model?: string;
  role: 'assistant' | 'user';
  content: string | ContentBlock[];
  stop_reason?: string | null;
  usage?: Usage;
}

// --- Frames from the CLI ----------------------------------------------------------

export interface SdkAssistantMessage {
  type: 'assistant';
  message: ApiMessage;
  parent_tool_use_id: string | null;
  uuid?: string;
  session_id?: string;
  user_message_uuid?: string;
  user_message_uuids?: string[];
  error?: unknown;
}

export interface SdkUserMessage {
  type: 'user';
  message: ApiMessage;
  parent_tool_use_id: string | null;
  uuid?: string;
  session_id?: string;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  timestamp?: string;
}

export interface SdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | string;
  is_error: boolean;
  duration_ms?: number;
  result?: string;
  errors?: string[];
  session_id?: string;
  usage?: Usage;
  total_cost_usd?: number;
  modelUsage?: Record<string, { contextWindow?: number; [k: string]: unknown }>;
}

export interface SdkSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  slash_commands?: string[];
  tools?: string[];
  claude_code_version?: string;
}

export interface SdkSystemOther {
  type: 'system';
  subtype: string;
  session_id?: string;
  [k: string]: unknown;
}

export interface StreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | string;
  index?: number;
  message?: ApiMessage;
  content_block?: ContentBlock;
  delta?: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'signature_delta' } | { type: string; [k: string]: unknown };
  usage?: Usage;
}

export interface SdkStreamEvent {
  type: 'stream_event';
  event: StreamEvent;
  parent_tool_use_id: string | null;
  session_id?: string;
}

export interface RateLimitWindow {
  utilization?: number;
  resetsAt?: number;
}

export interface SdkRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
    unifiedWindows?: Record<string, RateLimitWindow>;
    [k: string]: unknown;
  };
}

export type SdkMessage = SdkAssistantMessage | SdkUserMessage | SdkResultMessage | SdkSystemInit | SdkSystemOther | SdkStreamEvent | SdkRateLimitEvent | { type: string; [k: string]: unknown };

// --- Frames we send ---------------------------------------------------------------

export interface SdkUserMessageIn {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid?: string;
}

// --- Control protocol ---------------------------------------------------------------

export interface ControlRequestInner {
  subtype: string;
}

export interface PermissionUpdate {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories';
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: 'allow' | 'deny' | 'ask';
  destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
  mode?: PermissionMode;
  directories?: string[];
}

export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  decision_reason_type?: string;
  title?: string;
  display_name?: string;
  description?: string;
  tool_use_id?: string;
  agent_id?: string;
  suppress_always_allow_rule?: boolean;
  default_to_no?: boolean;
  requires_user_interaction?: boolean;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: 'user_temporary' | 'user_permanent' }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: 'user_reject' };

export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface InitializeResponse {
  commands?: SlashCommand[];
  models?: ModelInfo[];
  account?: { email?: string; subscriptionType?: string; organization?: string; apiProvider?: string };
  pid?: number;
  claude_code_version?: string;
  current_permission_mode?: PermissionMode;
  session_state?: string;
  pending_permission_requests?: { request_id: string; request: CanUseToolRequest }[];
  [k: string]: unknown;
}

export interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface GetUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: UsageWindow | null;
    seven_day?: UsageWindow | null;
    seven_day_opus?: UsageWindow | null;
    seven_day_sonnet?: UsageWindow | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
    extra_usage?: { is_enabled: boolean; utilization: number | null; used_credits?: number | null; monthly_limit?: number | null } | null;
    [k: string]: unknown;
  } | null;
}
