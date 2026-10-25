import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ClaudeProcess, type ControlRequestEvent, type ExitEvent } from '../claude/ClaudeProcess';
import { transcriptPathFor } from '../claude/paths';
import type {
  CanUseToolRequest,
  ContentBlock,
  InitializeResponse,
  ModelInfo,
  PermissionResult,
  PermissionUpdate,
  SdkAssistantMessage,
  SdkMessage,
  SdkRateLimitEvent,
  SdkResultMessage,
  SdkStreamEvent,
  SdkSystemInit,
  SdkUserMessage,
  SlashCommand,
} from '../claude/sdkTypes';
import { loadTranscriptFile } from '../claude/transcript';
import type {
  ChatState,
  ChatStatePatch,
  ContextUsageView,
  EffortLevel,
  ElicitationRequestView,
  ExtToChatMessage,
  PromptPreset,
  ImageAttachment,
  ModelOption,
  PendingRequestView,
  PermissionMode,
  QuestionView,
  SessionStatus,
  SlashCommandInfo,
  ToolItem,
  UserItem,
} from '../shared/protocol';
import { Emitter, type Event } from '../util/events';
import { errorMessage, type Logger } from '../util/log';
import { ChatBuilder } from './chatBuilder';
import { DENY_MESSAGE, denyWithFeedback, permissionOptions, sanitizeDisplay } from './permissionText';
import { fieldsFromSchema, normalizeElicitation, validateElicitation, type ElicitationValue } from './elicitation';
import { bookmarkFor, resolveBookmarks, toViews, type BookmarkStore, type StoredBookmark } from './bookmarks';
import { clip, describeToolActivity, prettyModelName } from './toolText';

export interface SessionSettings {
  defaultPermissionMode: PermissionMode;
  defaultModel: string;
  allowBypass: boolean;
  showThinking: boolean;
  /** Effort for new sessions ('' = the model's default). */
  defaultEffort: EffortLevel | '';
  /** Prompt presets shown in the composer. */
  promptPresets: PromptPreset[];
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function asEffort(v: unknown): EffortLevel | undefined {
  return typeof v === 'string' && (EFFORTS as string[]).includes(v) ? (v as EffortLevel) : undefined;
}

/** What a session needs from the rest of the extension. */
export interface SessionServices {
  log: Logger;
  getCliPath(): Promise<string | undefined>;
  getPathEnv(): Promise<string>;
  settings(): SessionSettings;
  imageSink(img: ImageAttachment): ImageAttachment;
  /** Last known models/commands from any Claude process (shown before this session's process starts). */
  sharedInit: { models?: ModelInfo[]; commands?: SlashCommand[] };
  onInitialized(init: InitializeResponse): void;
  onRateLimit(event: SdkRateLimitEvent): void;
  /** Called when our process wrote to the transcript (so the session index refreshes titles). */
  onTranscriptActivity(sessionId: string, cwd: string): void;
  /** Persisted message bookmarks. */
  bookmarks: BookmarkStore;
  /**
   * The model and effort Claude Code would use in `cwd` (from its settings),
   * asked from a short-lived CLI process; lets the chat show them before the
   * session's own process starts.
   */
  probeDefaults(cwd: string): Promise<ProbedDefaults | undefined>;
}

export interface ProbedDefaults {
  model?: string;
  effort?: string | null;
  models?: ModelInfo[];
}

export interface ManagedSessionInit {
  cwd: string;
  /** Existing session to show/resume. Omit for a brand-new session. */
  sessionId?: string;
  projectName: string;
  branch?: string;
  isWorktree?: boolean;
  title?: string;
  permissionMode?: PermissionMode;
  model?: string;
}

interface PendingEntry {
  view: PendingRequestView;
  /** The can_use_tool request (absent for MCP elicitations). */
  raw?: CanUseToolRequest;
}

export type AttentionReason = 'permission' | 'question' | 'plan' | 'input' | 'done' | 'error';

const INITIAL_HISTORY_ITEMS = 400;
const FLUSH_MS = 40;

/**
 * One session opened in this window ("Open here"): its chat history, its
 * Claude process (started on demand) and everything the chat panel shows.
 */
export class ManagedSession {
  readonly key: string;
  sessionId: string;
  readonly cwd: string;
  projectName: string;
  branch: string | undefined;
  isWorktree: boolean;
  title: string;
  private titleFromUser = false;

  status: SessionStatus;
  activity: string | undefined;
  turnStartedAt: number | undefined;
  permissionMode: PermissionMode;
  modelValue: string | undefined;
  modelLabel: string | undefined;
  /** Effort in use (reported by Claude Code) or chosen for the next start. */
  effort: EffortLevel | undefined;
  /** Effort to start the process with ('default' = no --effort flag). */
  private effortChoice: EffortLevel | 'default' | undefined;
  private bookmarks: StoredBookmark[] = [];
  private resolvedModel: string | undefined;
  private models: ModelOption[] = [];
  private modelInfos: ModelInfo[] = [];
  private commands: SlashCommandInfo[] = [];
  private readonly pending = new Map<string, PendingEntry>();
  contextUsage: ContextUsageView | undefined;
  private contextWindow: number | undefined;
  liveElsewhere: ChatState['liveElsewhere'];
  error: string | undefined;

  /** The latest turn finished while the user was not looking. */
  unread = false;
  /** Epoch ms of the last status change (for sorting / "since"). */
  statusSince = Date.now();
  /** Epoch ms of the last activity of any kind (idle reaper). */
  lastActivityAt = Date.now();
  /** Text of the last assistant message (for notifications). */
  lastAssistantText: string | undefined;

  private hasTranscript: boolean;
  private historyLoaded = false;
  private historyTruncated = false;
  private wantFullHistory = false;
  private builder: ChatBuilder;
  private proc: ClaudeProcess | undefined;
  private procStarting: Promise<ClaudeProcess | undefined> | undefined;
  private stoppingProc: ClaudeProcess | undefined;
  private queued: string[] = [];
  private forkOnNextStart = false;
  private uiPatch: ChatStatePatch = {};
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Number of chat panels showing this session that are visible. */
  visibleCount = 0;
  /** True when one of those panels is the active editor and the window is focused. */
  focused = false;

  private readonly _onDidChange = new Emitter<void>();
  /** Status, title, pending requests or unread changed (dashboard / tree / badge). */
  readonly onDidChange: Event<void> = this._onDidChange.event;

  private readonly _onUiMessage = new Emitter<ExtToChatMessage>();
  readonly onUiMessage: Event<ExtToChatMessage> = this._onUiMessage.event;

  private readonly _onNeedsAttention = new Emitter<{ reason: AttentionReason; detail?: string }>();
  readonly onNeedsAttention = this._onNeedsAttention.event;

  constructor(
    init: ManagedSessionInit,
    private readonly services: SessionServices,
  ) {
    this.cwd = init.cwd;
    this.projectName = init.projectName;
    this.branch = init.branch === 'HEAD' ? undefined : init.branch;
    this.isWorktree = !!init.isWorktree;
    const settings = services.settings();
    this.permissionMode = init.permissionMode ?? settings.defaultPermissionMode;
    this.modelValue = init.model ?? (settings.defaultModel || undefined);
    this.effortChoice = settings.defaultEffort || undefined;
    this.effort = settings.defaultEffort || undefined;
    if (init.sessionId) {
      this.sessionId = init.sessionId;
      this.key = init.sessionId;
      this.hasTranscript = existsSync(transcriptPathFor(init.cwd, init.sessionId));
      this.status = 'idle';
      this.title = init.title || 'Session';
    } else {
      this.sessionId = randomUUID();
      this.key = this.sessionId;
      this.hasTranscript = false;
      this.status = 'new';
      this.title = init.title || 'New session';
      this.historyLoaded = true;
    }
    this.builder = new ChatBuilder(services.imageSink);
    this.bookmarks = services.bookmarks.load(this.sessionId);
    this.applySharedInit();
  }

  private get log(): Logger {
    return this.services.log;
  }

  get isNew(): boolean {
    return this.status === 'new';
  }

  get processAlive(): boolean {
    return !!this.proc?.alive;
  }

  get pid(): number | undefined {
    return this.proc?.alive ? this.proc.pid : undefined;
  }

  /** The running Claude process, if any (used for get_usage). */
  get liveProcess(): ClaudeProcess | undefined {
    return this.proc?.alive && !this.procStarting ? this.proc : undefined;
  }

  get pendingRequests(): PendingRequestView[] {
    return [...this.pending.values()].map((p) => p.view).sort((a, b) => a.createdAt - b.createdAt);
  }

  get transcriptPath(): string {
    return transcriptPathFor(this.cwd, this.sessionId);
  }

  /** Name, full input and state of a tool call (pending requests carry the untruncated input). */
  toolInfo(toolUseId: string): { name: string; input: Record<string, unknown>; status?: ToolItem['status']; pending: boolean } | undefined {
    for (const p of this.pending.values()) {
      if (p.raw && p.raw.tool_use_id === toolUseId) return { name: p.raw.tool_name, input: p.raw.input ?? {}, pending: true, status: 'waiting-permission' };
    }
    const item = this.builder.get<ToolItem>(toolUseId);
    if (item?.kind === 'tool') return { name: item.name, input: item.input, status: item.status, pending: false };
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // State for the webview
  // ---------------------------------------------------------------------------

  async ensureHistory(): Promise<void> {
    if (this.historyLoaded) return;
    this.historyLoaded = true;
    const builder = new ChatBuilder(this.services.imageSink);
    const started = Date.now();
    const info = await loadTranscriptFile(this.transcriptPath, builder);
    if (info) {
      this.hasTranscript = true;
      // Keep anything that happened while we were loading.
      for (const it of this.builder.items) builder.upsert(it);
      this.builder = builder;
      // Tools with no result while no Claude process runs this session anywhere:
      // the turn was cut off (VS Code reloaded or Claude exited). Don't show them as running.
      if (!this.proc?.alive && !this.liveElsewhere && builder.settleOpenTools('interrupted') > 0) {
        builder.addSystem('warning', 'Claude stopped before finishing this turn (VS Code reloaded or Claude exited). Send a message, like "continue", to pick it up.', 'interrupted');
      }
      if (info.customTitle) {
        this.title = info.customTitle;
        this.titleFromUser = true;
      } else if (info.aiTitle && !this.titleFromUser) this.title = info.aiTitle;
      // Claude records "HEAD" when the folder isn't a git repo (or is detached): not a branch name.
      if (info.gitBranch && info.gitBranch !== 'HEAD' && !this.branch) this.branch = info.gitBranch;
      if (builder.lastModel) this.setResolvedModel(builder.lastModel);
      if (info.effort && !this.effort) this.effort = asEffort(info.effort);
      this.updateContextUsage();
      this.log.info(`loaded ${builder.size} items for ${this.sessionId} in ${Date.now() - started} ms`);
    }
    this.syncBookmarks();
    this.builder.clearChanges();
  }

  getState(): ChatState {
    const settings = this.services.settings();
    const snap = this.builder.snapshot(this.wantFullHistory ? undefined : INITIAL_HISTORY_ITEMS);
    this.historyTruncated = snap.truncated;
    this.builder.clearChanges();
    return {
      key: this.key,
      sessionId: this.hasTranscript || this.proc ? this.sessionId : undefined,
      cwd: this.cwd,
      projectName: this.projectName,
      branch: this.branch,
      isWorktree: this.isWorktree,
      title: this.title,
      status: this.status,
      activity: this.activity,
      turnStartedAt: this.turnStartedAt,
      modelLabel: this.modelLabel,
      modelValue: this.modelValue,
      effort: this.effort,
      availableEfforts: this.availableEfforts(),
      permissionMode: this.permissionMode,
      availableModes: this.availableModes(settings.allowBypass),
      availableModels: this.models,
      slashCommands: this.commands,
      items: snap.items,
      pending: this.pendingRequests,
      bookmarks: toViews(this.bookmarks),
      promptPresets: settings.promptPresets,
      todos: this.builder.todos,
      contextUsage: this.contextUsage,
      liveElsewhere: this.liveElsewhere,
      error: this.error,
      historyTruncated: snap.truncated,
      allowBypass: settings.allowBypass,
      canAttachImages: true,
    };
  }

  loadFullHistory(): void {
    this.wantFullHistory = true;
    this._onUiMessage.fire({ type: 'state', state: this.getState() });
  }

  private availableModes(allowBypass: boolean): PermissionMode[] {
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
    if (allowBypass || this.permissionMode === 'bypassPermissions') modes.push('bypassPermissions');
    return modes;
  }

  private patchUi(patch: ChatStatePatch): void {
    Object.assign(this.uiPatch, patch);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Sends pending item changes and field patches to the webview. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const changes = this.builder.takeChanges();
    if (changes.removed.length) this._onUiMessage.fire({ type: 'remove-items', ids: changes.removed });
    if (changes.upserts.length) this._onUiMessage.fire({ type: 'items', items: changes.upserts });
    for (const d of changes.deltas) this._onUiMessage.fire({ type: 'delta', id: d.id, field: d.field, text: d.text });
    if (Object.keys(this.uiPatch).length) {
      // JSON drops undefined values, so cleared fields are sent as null.
      const patch: ChatStatePatch = {};
      for (const [k, v] of Object.entries(this.uiPatch)) (patch as Record<string, unknown>)[k] = v === undefined ? null : v;
      this.uiPatch = {};
      this._onUiMessage.fire({ type: 'patch', patch });
    }
  }

  private setStatus(status: SessionStatus, activity?: string): void {
    const changed = status !== this.status;
    if (changed) {
      this.status = status;
      this.statusSince = Date.now();
    }
    if (status === 'running' && !this.turnStartedAt) this.turnStartedAt = Date.now();
    if (status === 'idle' || status === 'new' || status === 'error') this.turnStartedAt = undefined;
    if (activity !== undefined || status !== 'running') this.activity = status === 'running' || status === 'starting' ? activity ?? this.activity : undefined;
    this.patchUi({ status: this.status, activity: this.activity, turnStartedAt: this.turnStartedAt, error: this.error });
    if (changed) this._onDidChange.fire();
  }

  private setActivity(activity: string | undefined): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.patchUi({ activity });
    this._onDidChange.fire();
  }

  // ---------------------------------------------------------------------------
  // Commands from the panel / dashboard
  // ---------------------------------------------------------------------------

  async send(text: string, images: ImageAttachment[] = []): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !images.length) return;
    await this.ensureHistory();
    this.lastActivityAt = Date.now();
    this.unread = false;
    this.error = undefined;
    const uuid = randomUUID();
    const busy = this.status === 'running' || this.status === 'waiting' || this.status === 'starting';
    const command = trimmed.startsWith('/') ? trimmed.slice(1).split(/\s+/)[0] : undefined;
    const item: UserItem = { kind: 'user', id: uuid, text: trimmed, timestamp: Date.now(), queued: busy || undefined, command };
    if (images.length) item.images = images.map(this.services.imageSink);
    this.builder.upsert(item);
    if (busy) this.queued.push(uuid);
    if (this.isNew && this.title === 'New session') this.setTitle(clip(trimmed || 'Image', 60), false);
    if (!busy) this.setStatus('starting', 'Starting Claude');
    this.flush();

    const proc = await this.ensureProcess();
    if (!proc) return;
    const content: string | ContentBlock[] = images.length
      ? [...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })), { type: 'text' as const, text: trimmed || 'See the attached image.' }]
      : trimmed;
    const ok = proc.sendUserMessage({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.sessionId, uuid });
    if (!ok) {
      this.fail('Could not send the message: Claude stopped accepting input.');
      return;
    }
    if (!busy || this.status === 'idle' || this.status === 'starting') this.setStatus('running', 'Thinking');
  }

  async interrupt(): Promise<void> {
    this.lastActivityAt = Date.now();
    if (!this.proc?.alive) return;
    try {
      await this.proc.interrupt();
    } catch (err) {
      this.log.warn(`interrupt failed: ${errorMessage(err)}`);
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (mode === this.permissionMode) return;
    const prev = this.permissionMode;
    this.permissionMode = mode;
    this.patchUi({ permissionMode: mode, availableModes: this.availableModes(this.services.settings().allowBypass) });
    if (this.proc?.alive && !this.procStarting) {
      try {
        await this.proc.setPermissionMode(mode);
      } catch (err) {
        this.permissionMode = prev;
        this.patchUi({ permissionMode: prev });
        this.builder.addSystem('error', `Could not switch mode: ${errorMessage(err)}`);
        this.flush();
      }
    }
  }

  async setModel(model: string): Promise<void> {
    const value = model || undefined;
    this.modelValue = value;
    this.canonicalizeModelValue();
    this.modelLabel = this.labelFor(value) ?? this.modelLabel;
    this.patchUi({ modelValue: this.modelValue, modelLabel: this.modelLabel, availableEfforts: this.availableEfforts() });
    if (this.proc?.alive && !this.procStarting) {
      try {
        await this.proc.setModel(value ?? 'default');
        await this.syncSettings();
        this.builder.addSystem('info', `Model set to ${this.modelLabel ?? value ?? 'default'}`, 'model');
        this.flush();
      } catch (err) {
        this.builder.addSystem('error', `Could not switch model: ${errorMessage(err)}`);
        this.flush();
      }
    }
  }

  /**
   * Shows the model and effort the session will start with (before its own
   * process runs). Choices the user already made in this chat are kept.
   */
  async loadDefaults(): Promise<void> {
    if (this.proc || this.disposed) return;
    const d = await this.services.probeDefaults(this.cwd).catch(() => undefined);
    if (!d || this.proc || this.disposed) return;
    if (d.models?.length && !this.modelInfos.length) this.setModels(d.models, false);
    if (!this.modelValue && d.model) this.setResolvedModel(d.model);
    else if (this.modelValue) {
      this.modelLabel = this.labelFor(this.modelValue);
      this.canonicalizeModelValue();
    }
    if (this.effortChoice === undefined && !this.effort) this.effort = d.effort === null ? undefined : asEffort(d.effort);
    this.patchUi({ availableModels: this.models, modelValue: this.modelValue, modelLabel: this.modelLabel, effort: this.effort ?? null, availableEfforts: this.availableEfforts() });
    this.flush();
  }

  /** Settings changed: refresh what the panel shows from them. */
  settingsChanged(): void {
    const settings = this.services.settings();
    this.patchUi({ promptPresets: settings.promptPresets, allowBypass: settings.allowBypass, availableModes: this.availableModes(settings.allowBypass) });
    this.flush();
  }

  /** Changes the reasoning effort ('default' = the model's default). Applies from the next request. */
  async setEffort(effort: EffortLevel | 'default'): Promise<void> {
    this.effortChoice = effort;
    const prev = this.effort;
    this.effort = effort === 'default' ? undefined : effort;
    this.patchUi({ effort: this.effort });
    if (this.proc?.alive && !this.procStarting) {
      try {
        await this.proc.request({ subtype: 'apply_flag_settings', settings: { effortLevel: effort === 'default' ? null : effort } }, 15_000);
        await this.syncSettings();
        this.builder.addSystem('info', `Effort set to ${this.effort ? EFFORT_NAMES[this.effort] : 'the model default'}`, 'model');
      } catch (err) {
        this.effort = prev;
        this.patchUi({ effort: prev });
        this.builder.addSystem('error', `Could not change effort: ${errorMessage(err)}`);
      }
      this.flush();
    }
  }

  /** Reads the model and effort Claude Code actually applies (after org caps and model downgrades). */
  private async syncSettings(): Promise<void> {
    const proc = this.proc;
    if (!proc?.alive) return;
    try {
      const res = await proc.request<{ applied?: { model?: string; effort?: string | null } }>({ subtype: 'get_settings' }, 10_000);
      const applied = res.applied;
      if (!applied) return;
      if (applied.model && applied.model !== this.resolvedModel) this.setResolvedModel(applied.model);
      const effort = applied.effort === null ? undefined : asEffort(applied.effort);
      if (effort !== this.effort) {
        this.effort = effort;
        this.patchUi({ effort });
      }
    } catch {
      // Older CLIs without get_settings: keep what we have.
    }
  }

  /**
   * The model-list entry for a value: an alias ("opus") or a full model id
   * ("claude-opus-5-5", as people often put in settings), matched to the alias
   * that resolves to it.
   */
  private modelInfoFor(value: string | undefined): ModelInfo | undefined {
    if (!value) return undefined;
    return (
      this.modelInfos.find((m) => m.value === value) ??
      this.modelInfos.find((m) => m.value !== 'default' && m.resolvedModel === value) ??
      this.modelInfos.find((m) => m.resolvedModel === value)
    );
  }

  /** Use the list's own value for the chosen model, so the picker can tick it. */
  private canonicalizeModelValue(): void {
    const info = this.modelInfoFor(this.modelValue);
    if (info && info.value !== this.modelValue) this.modelValue = info.value;
  }

  private labelFor(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const info = this.modelInfoFor(value);
    return info && !/^Default\b/.test(info.displayName) ? info.displayName.replace(/\s*\(recommended\)\s*/i, '') : prettyModelName(info?.resolvedModel ?? value);
  }

  private currentModelInfo(): ModelInfo | undefined {
    return (
      this.modelInfoFor(this.modelValue) ??
      (this.resolvedModel ? this.modelInfos.find((m) => m.value !== 'default' && m.resolvedModel === this.resolvedModel) ?? this.modelInfos.find((m) => m.resolvedModel === this.resolvedModel) : undefined)
    );
  }

  private availableEfforts(): EffortLevel[] {
    const info = this.currentModelInfo();
    const levels = (info?.supportedEffortLevels ?? []).map(asEffort).filter((e): e is EffortLevel => !!e);
    if (!info && this.modelInfos.length === 0) return [];
    return levels;
  }

  // ---------------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------------

  toggleBookmark(itemId: string): void {
    const i = this.bookmarks.findIndex((b) => b.itemId === itemId);
    if (i >= 0) {
      this.bookmarks = this.bookmarks.filter((_, j) => j !== i);
    } else {
      const item = this.builder.get(itemId);
      const b = item ? bookmarkFor(item, this.cwd) : undefined;
      if (!b) return;
      this.bookmarks = [...this.bookmarks, b];
    }
    this.services.bookmarks.save(this.sessionId, this.bookmarks);
    this.patchUi({ bookmarks: toViews(this.bookmarks) });
    this.flush();
  }

  get bookmarkCount(): number {
    return this.bookmarks.length;
  }

  /** Re-attaches stored bookmarks to the loaded items (ids can change across reloads). */
  private syncBookmarks(): void {
    const { list, changed } = resolveBookmarks(this.bookmarks, this.builder.items);
    if (!changed) return;
    this.bookmarks = list;
    this.services.bookmarks.save(this.sessionId, list);
    this.patchUi({ bookmarks: toViews(list) });
  }

  /** Answer an MCP server's request for input (elicitation). */
  respondElicitation(requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, ElicitationValue>): string | undefined {
    const entry = this.pending.get(requestId);
    if (!entry || entry.view.kind !== 'elicitation' || !this.proc) return undefined;
    const view = entry.view;
    let payload: Record<string, unknown> = { action };
    if (action === 'accept' && view.mode === 'form') {
      const values = content ?? {};
      const errors = validateElicitation(view.fields, values);
      const first = Object.keys(errors)[0];
      if (first) return `${view.fields.find((f) => f.name === first)?.label ?? first}: ${errors[first]}`;
      payload = { action, content: normalizeElicitation(view.fields, values) };
    }
    this.proc.respond(requestId, payload);
    const verb = action === 'accept' ? (view.mode === 'url' ? 'Opened the link for' : 'Answered') : action === 'decline' ? 'Declined' : 'Dismissed';
    this.builder.addSystem('info', `${verb} ${view.title ?? view.serverName}'s request`);
    this.resolvePending(requestId);
    return undefined;
  }

  /** Answer a permission request. optionId: 'allow' | 'allow-always' | 'deny'. */
  respondPermission(requestId: string, optionId: string, feedback?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.view.kind !== 'permission' || !entry.raw || !this.proc) return;
    const raw = entry.raw;
    let result: PermissionResult;
    if (optionId === 'deny') {
      const fb = feedback?.trim();
      result = { behavior: 'deny', message: fb ? denyWithFeedback(fb) : DENY_MESSAGE, interrupt: !fb, toolUseID: raw.tool_use_id, decisionClassification: 'user_reject' };
      this.builder.setToolStatus(raw.tool_use_id, 'denied');
    } else {
      const always = optionId === 'allow-always';
      const updatedPermissions = always ? raw.permission_suggestions : undefined;
      result = { behavior: 'allow', updatedInput: raw.input, updatedPermissions, toolUseID: raw.tool_use_id, decisionClassification: always ? 'user_permanent' : 'user_temporary' };
      this.builder.setToolStatus(raw.tool_use_id, 'running');
      const mode = updatedPermissions?.find((u) => u.type === 'setMode')?.mode;
      if (mode) {
        this.permissionMode = mode;
        this.patchUi({ permissionMode: mode });
      }
    }
    this.proc.respond(requestId, result as unknown as Record<string, unknown>);
    this.resolvePending(requestId);
  }

  respondQuestion(requestId: string, answers: Record<string, string>, cancelled?: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.view.kind !== 'question' || !entry.raw || !this.proc) return;
    const raw = entry.raw;
    const result: PermissionResult = cancelled
      ? { behavior: 'deny', message: 'The user declined to answer the questions.', interrupt: true, toolUseID: raw.tool_use_id }
      : { behavior: 'allow', updatedInput: { ...raw.input, answers }, toolUseID: raw.tool_use_id };
    this.builder.setToolStatus(raw.tool_use_id, cancelled ? 'denied' : 'running');
    this.proc.respond(requestId, result as unknown as Record<string, unknown>);
    this.resolvePending(requestId);
  }

  respondPlan(requestId: string, decision: 'accept-auto' | 'accept-manual' | 'reject', feedback?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.view.kind !== 'plan' || !entry.raw || !this.proc) return;
    const raw = entry.raw;
    const proc = this.proc;
    if (decision === 'reject') {
      const fb = feedback?.trim();
      const result: PermissionResult = {
        behavior: 'deny',
        message: fb ? `The user doesn't want to proceed with this plan yet. Keep planning. The user said:\n${fb}` : 'The user rejected the plan. Stay in plan mode and wait for the user to tell you how to proceed.',
        interrupt: !fb,
        toolUseID: raw.tool_use_id,
        decisionClassification: 'user_reject',
      };
      this.builder.setToolStatus(raw.tool_use_id, 'denied');
      proc.respond(requestId, result as unknown as Record<string, unknown>);
    } else {
      const mode: PermissionMode = decision === 'accept-auto' ? 'acceptEdits' : 'default';
      const updatedPermissions: PermissionUpdate[] = [{ type: 'setMode', mode, destination: 'session' }];
      const result: PermissionResult = { behavior: 'allow', updatedInput: raw.input, updatedPermissions, toolUseID: raw.tool_use_id, decisionClassification: 'user_temporary' };
      this.builder.setToolStatus(raw.tool_use_id, 'running');
      proc.respond(requestId, result as unknown as Record<string, unknown>);
      this.permissionMode = mode;
      this.patchUi({ permissionMode: mode });
      // Older CLIs ignore setMode in the answer; make sure plan mode is left.
      setTimeout(() => {
        if (proc.alive) proc.setPermissionMode(mode).catch(() => {});
      }, 300);
    }
    this.resolvePending(requestId);
  }

  private resolvePending(requestId: string): void {
    this.pending.delete(requestId);
    this.lastActivityAt = Date.now();
    this.patchUi({ pending: this.pendingRequests });
    // An MCP request can arrive outside a turn; only resume "running" if a turn was going.
    if (this.pending.size === 0 && this.status === 'waiting') this.setStatus(this.turnStartedAt ? 'running' : 'idle', this.turnStartedAt ? 'Working' : undefined);
    this.flush();
    this._onDidChange.fire();
  }

  /** The user looked at the latest output. */
  markSeen(): void {
    if (!this.unread) return;
    this.unread = false;
    this._onDidChange.fire();
  }

  setTitle(title: string, fromUser: boolean): void {
    if (!title || (this.titleFromUser && !fromUser)) return;
    if (fromUser) this.titleFromUser = true;
    if (title === this.title) return;
    this.title = title;
    this.patchUi({ title });
    this._onDidChange.fire();
  }

  setLiveElsewhere(info: ChatState['liveElsewhere']): void {
    const same = JSON.stringify(info) === JSON.stringify(this.liveElsewhere);
    if (same) return;
    this.liveElsewhere = info;
    this.patchUi({ liveElsewhere: info });
    this._onDidChange.fire();
  }

  setBranch(branch: string | undefined): void {
    if (branch === 'HEAD') branch = undefined;
    if (branch === this.branch) return;
    this.branch = branch;
    this.patchUi({ branch });
  }

  async restart(): Promise<void> {
    this.error = undefined;
    await this.stopProcess();
    this.setStatus(this.hasTranscript ? 'idle' : 'new');
    this.flush();
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle
  // ---------------------------------------------------------------------------

  /** Starts the Claude process if needed. Resolves undefined when it could not start. */
  ensureProcess(): Promise<ClaudeProcess | undefined> {
    if (this.proc?.alive) return Promise.resolve(this.proc);
    if (this.procStarting) return this.procStarting;
    this.procStarting = this.startProcess().finally(() => {
      this.procStarting = undefined;
    });
    return this.procStarting;
  }

  private async startProcess(): Promise<ClaudeProcess | undefined> {
    const cliPath = await this.services.getCliPath();
    if (!cliPath) {
      this.fail('Claude Code CLI not found. Install it (https://claude.com/claude-code) or set "claudeProjects.claudePath".');
      return undefined;
    }
    const settings = this.services.settings();
    const fork = this.forkOnNextStart && this.hasTranscript;
    this.forkOnNextStart = false;
    const proc = new ClaudeProcess({
      cliPath,
      cwd: this.cwd,
      resume: this.hasTranscript ? this.sessionId : undefined,
      sessionId: this.hasTranscript ? undefined : this.sessionId,
      forkSession: fork,
      permissionMode: this.permissionMode,
      model: this.modelValue,
      effort: this.effortChoice && this.effortChoice !== 'default' ? this.effortChoice : undefined,
      allowDangerouslySkipPermissions: settings.allowBypass || this.permissionMode === 'bypassPermissions',
      thinkingDisplay: settings.showThinking ? 'summarized' : undefined,
      pathEnv: await this.services.getPathEnv(),
      log: this.log,
    });
    proc.onMessage((m) => this.onMessage(proc, m));
    proc.onControlRequest((r) => this.onControlRequest(proc, r));
    proc.onControlCancel((id) => this.onControlCancel(id));
    proc.onExit((e) => this.onExit(proc, e));
    try {
      proc.start();
    } catch (err) {
      this.fail(`Could not start Claude: ${errorMessage(err)}`);
      return undefined;
    }
    this.proc = proc;
    try {
      const init = await proc.initialize();
      this.onInitialized(init);
      await this.syncSettings();
      this.flush();
      if (fork) {
        this.builder.addSystem('info', 'This session was open somewhere else, so it continues here as a copy.', 'forked');
        this.flush();
      }
      return proc;
    } catch (err) {
      if (!proc.alive) return undefined; // onExit reports the error
      this.log.warn(`initialize failed: ${errorMessage(err)}`);
      return proc; // still usable without the extra info
    }
  }

  private onInitialized(init: InitializeResponse): void {
    this.services.onInitialized(init);
    if (init.models?.length) this.setModels(init.models);
    if (init.commands?.length) this.setCommands(init.commands);
    if (init.current_permission_mode && init.current_permission_mode !== this.permissionMode) {
      this.permissionMode = init.current_permission_mode;
      this.patchUi({ permissionMode: this.permissionMode });
    }
    this.flush();
  }

  private applySharedInit(): void {
    const s = this.services.sharedInit;
    if (s.models?.length) this.setModels(s.models, false);
    if (s.commands?.length) this.setCommands(s.commands, false);
  }

  private setModels(models: ModelInfo[], patch = true): void {
    this.modelInfos = models;
    this.models = models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      efforts: (m.supportedEffortLevels ?? []).map(asEffort).filter((e): e is EffortLevel => !!e),
    }));
    if (this.resolvedModel) this.setResolvedModel(this.resolvedModel);
    else if (this.modelValue) this.modelLabel = this.labelFor(this.modelValue);
    this.canonicalizeModelValue();
    if (patch) this.patchUi({ availableModels: this.models, modelLabel: this.modelLabel, modelValue: this.modelValue, availableEfforts: this.availableEfforts() });
  }

  private setCommands(commands: SlashCommand[], patch = true): void {
    this.commands = commands.map((c) => ({ name: c.name.replace(/^\//, ''), description: c.description, argumentHint: c.argumentHint }));
    if (patch) this.patchUi({ slashCommands: this.commands });
  }

  private setResolvedModel(model: string): void {
    this.resolvedModel = model;
    const info = this.modelInfos.find((m) => m.resolvedModel === model) ?? this.modelInfos.find((m) => m.value === model);
    this.modelLabel = info ? info.displayName.replace(/\s*\(recommended\)\s*/i, '').replace(/^Default\s*$/, prettyModelName(model)) : prettyModelName(model);
    if (info?.displayName.startsWith('Default')) this.modelLabel = prettyModelName(model);
    // Tick the matching entry in the model picker (prefer the named alias over "default").
    if (!this.modelValue) {
      const match = this.modelInfos.find((m) => m.value !== 'default' && m.resolvedModel === model) ?? this.modelInfos.find((m) => m.resolvedModel === model);
      if (match) this.modelValue = match.value;
    }
    this.patchUi({ modelLabel: this.modelLabel, modelValue: this.modelValue, availableEfforts: this.availableEfforts() });
  }

  private onExit(proc: ClaudeProcess, e: ExitEvent): void {
    if (this.proc !== proc) return;
    this.proc = undefined;
    const intentional = this.stoppingProc === proc;
    this.stoppingProc = undefined;
    const hadPending = this.pending.size > 0;
    this.pending.clear();
    this.builder.endStreaming();
    const wasBusy = this.status === 'running' || this.status === 'waiting' || this.status === 'starting';
    if (wasBusy) this.builder.settleOpenTools('interrupted');
    for (const id of this.queued) this.builder.patch<UserItem>(id, { queued: undefined });
    this.queued = [];
    if (hadPending) this.patchUi({ pending: [] });
    if (!intentional && (wasBusy || e.spawnError || (e.code !== 0 && e.code !== null))) {
      const detail = e.spawnError ?? lastMeaningfulLine(e.stderrTail) ?? `exit code ${e.code ?? e.signal}`;
      this.fail(`Claude stopped unexpectedly: ${detail}`);
      return;
    }
    if (this.status !== 'new') this.setStatus(this.hasTranscript ? 'idle' : 'new');
    this.flush();
  }

  private fail(message: string): void {
    this.error = message;
    this.builder.endStreaming();
    this.setStatus('error');
    this.flush();
    this._onNeedsAttention.fire({ reason: 'error', detail: message });
  }

  /** Stops the Claude process (the session stays and resumes on the next message). */
  async stopProcess(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stoppingProc = proc;
    await proc.close(2000);
  }

  /** Continue as a fork next time (used when the session is live elsewhere). */
  forkNextStart(): void {
    this.forkOnNextStart = true;
  }

  // ---------------------------------------------------------------------------
  // Frames from the CLI
  // ---------------------------------------------------------------------------

  private onMessage(proc: ClaudeProcess, m: SdkMessage): void {
    if (this.proc !== proc) return;
    this.lastActivityAt = Date.now();
    switch (m.type) {
      case 'system':
        this.onSystem(m as SystemFrame);
        break;
      case 'stream_event': {
        const se = m as SdkStreamEvent;
        this.consumeQueued((m as { user_message_uuids?: string[] }).user_message_uuids);
        this.builder.streamEvent(se.event, se.parent_tool_use_id);
        if (!se.parent_tool_use_id) {
          const cb = se.event.content_block as { type?: string; name?: string } | undefined;
          if (se.event.type === 'content_block_start' && cb) {
            if (cb.type === 'thinking') this.setActivity('Thinking');
            else if (cb.type === 'text') this.setActivity('Writing');
            else if (cb.type === 'tool_use' && cb.name) this.setActivity(describeToolActivity(cb.name, undefined, this.cwd));
          }
        }
        this.scheduleFlush();
        break;
      }
      case 'assistant': {
        const am = m as SdkAssistantMessage;
        this.consumeQueued(am.user_message_uuids);
        this.builder.addAssistant(am.message, am.parent_tool_use_id);
        if (!am.parent_tool_use_id) {
          const blocks = Array.isArray(am.message.content) ? am.message.content : [];
          for (const b of blocks) {
            if (b.type === 'tool_use') this.setActivity(describeToolActivity((b as { name: string }).name, (b as { input: Record<string, unknown> }).input, this.cwd));
            if (b.type === 'text' && (b as { text: string }).text.trim()) this.lastAssistantText = (b as { text: string }).text;
          }
          if (am.message.model && am.message.model !== '<synthetic>' && am.message.model !== this.resolvedModel) this.setResolvedModel(am.message.model);
          this.updateContextUsage();
          if (blocks.some((b) => b.type === 'tool_use' && (b as { name: string }).name === 'TodoWrite')) this.patchUi({ todos: this.builder.todos });
        }
        this.scheduleFlush();
        break;
      }
      case 'user': {
        const um = m as SdkUserMessage;
        this.builder.addUser(um.message, { uuid: um.uuid, parentToolUseId: um.parent_tool_use_id, toolUseResult: um.tool_use_result, timestamp: um.timestamp ? Date.parse(um.timestamp) : undefined });
        if (!um.parent_tool_use_id && this.status === 'running') this.setActivity('Thinking');
        this.scheduleFlush();
        break;
      }
      case 'result': {
        const r = m as SdkResultMessage;
        this.builder.endStreaming();
        const interrupted = r.subtype === 'error_during_execution' && !(r.errors?.length);
        const errorText = r.is_error && !interrupted ? (r.errors?.join('\n') || r.result || 'The turn ended with an error.') : undefined;
        this.builder.addTurnEnd({ durationMs: r.duration_ms, isError: !!errorText, errorText });
        const model = this.resolvedModel ? r.modelUsage?.[this.resolvedModel] : undefined;
        if (model?.contextWindow) this.contextWindow = model.contextWindow;
        this.updateContextUsage();
        this.flush();
        this.services.onTranscriptActivity(this.sessionId, this.cwd);
        break;
      }
      case 'rate_limit_event':
        this.services.onRateLimit(m as SdkRateLimitEvent);
        break;
      default:
        break;
    }
  }

  private onSystem(m: SystemFrame): void {
    switch (m.subtype) {
      case 'init': {
        if (m.session_id && m.session_id !== this.sessionId) {
          this.log.info(`session ${this.sessionId} continues as ${m.session_id}`);
          this.sessionId = m.session_id;
          if (this.bookmarks.length) this.services.bookmarks.save(m.session_id, this.bookmarks);
          this.patchUi({ sessionId: m.session_id });
          this._onDidChange.fire();
        }
        if (!this.hasTranscript) {
          this.hasTranscript = true;
          this.patchUi({ sessionId: this.sessionId });
        }
        if (m.model) this.setResolvedModel(m.model);
        if (m.permissionMode && m.permissionMode !== this.permissionMode) {
          this.permissionMode = m.permissionMode;
          this.patchUi({ permissionMode: m.permissionMode });
        }
        if (Array.isArray(m.slash_commands) && m.slash_commands.length) {
          const known = new Map(this.commands.map((c) => [c.name, c]));
          const merged = m.slash_commands.map((n) => known.get(n.replace(/^\//, '')) ?? { name: n.replace(/^\//, '') });
          this.commands = merged;
          this.patchUi({ slashCommands: merged });
        }
        break;
      }
      case 'session_state_changed': {
        const state = m.state as string;
        if (state === 'running') {
          if (this.pending.size === 0) this.setStatus('running');
        } else if (state === 'requires_action') {
          this.setStatus('waiting');
        } else if (state === 'idle') {
          this.onTurnIdle();
        }
        break;
      }
      case 'status': {
        if (m.permissionMode && m.permissionMode !== this.permissionMode) {
          this.permissionMode = m.permissionMode as PermissionMode;
          this.patchUi({ permissionMode: this.permissionMode });
        }
        if (m.status === 'compacting') this.setActivity('Compacting the conversation');
        if (m.compact_result === 'failed') this.builder.addSystem('error', `Compaction failed${m.compact_error ? `: ${String(m.compact_error)}` : ''}`);
        break;
      }
      case 'compact_boundary':
        this.builder.addSystem('info', 'Conversation compacted', 'compact');
        this.scheduleFlush();
        break;
      case 'api_retry': {
        const attempt = typeof m.attempt === 'number' ? m.attempt : undefined;
        const max = typeof m.max_retries === 'number' ? m.max_retries : undefined;
        const delay = typeof m.retry_delay_ms === 'number' ? Math.round(m.retry_delay_ms / 1000) : undefined;
        this.builder.addRetry(`API error, retrying${delay !== undefined ? ` in ${delay}s` : ''}${attempt ? ` (attempt ${attempt}${max ? `/${max}` : ''})` : ''}`);
        this.scheduleFlush();
        break;
      }
      case 'local_command_output': {
        const content = typeof m.content === 'string' ? m.content : typeof m.output === 'string' ? m.output : undefined;
        if (content) this.builder.addSystem('info', sanitizeDisplay(content)!.trim(), 'command-output');
        this.scheduleFlush();
        break;
      }
      case 'informational':
      case 'notification': {
        const text = typeof m.content === 'string' ? m.content : typeof m.message === 'string' ? m.message : typeof m.text === 'string' ? m.text : undefined;
        if (text) this.builder.addSystem('info', sanitizeDisplay(text)!);
        this.scheduleFlush();
        break;
      }
      case 'model_refusal_fallback': {
        const text = typeof m.content === 'string' ? m.content : 'The model declined; retrying with a fallback model.';
        this.builder.addSystem('warning', text);
        this.scheduleFlush();
        break;
      }
      case 'task_notification': {
        const summary = typeof m.summary === 'string' ? m.summary : undefined;
        // Agents run in the foreground already show their result on their tool row.
        const shownAsTool = typeof m.tool_use_id === 'string' && !!this.builder.get(m.tool_use_id);
        if (summary && !shownAsTool) this.builder.addSystem('info', `Background task: ${summary}`);
        this.scheduleFlush();
        break;
      }
      case 'commands_changed': {
        if (Array.isArray(m.commands)) this.setCommands(m.commands as SlashCommand[]);
        break;
      }
      default:
        break;
    }
  }

  private onTurnIdle(): void {
    this.builder.endStreaming();
    for (const id of this.queued) this.builder.patch<UserItem>(id, { queued: undefined });
    this.queued = [];
    // Tools still "running" when the turn is over were cut short.
    for (const it of this.builder.items) {
      if (it.kind === 'tool' && !it.parentToolUseId && (it.status === 'running' || it.status === 'pending' || it.status === 'waiting-permission')) {
        this.builder.patch<ToolItem>(it.id, { status: 'interrupted' });
      }
    }
    const wasWorking = this.status === 'running' || this.status === 'waiting';
    this.setStatus('idle');
    this.flush();
    if (wasWorking) {
      if (!this.focused) this.unread = true;
      this._onDidChange.fire();
      this._onNeedsAttention.fire({ reason: 'done', detail: this.lastAssistantText ? clip(this.lastAssistantText, 140) : undefined });
    }
  }

  /** Queued messages Claude has picked up move from the bottom into the conversation. */
  private consumeQueued(uuids: string[] | undefined): void {
    if (!uuids?.length || !this.queued.length) return;
    for (const id of uuids) {
      const i = this.queued.indexOf(id);
      if (i < 0) continue;
      this.queued.splice(i, 1);
      this.builder.patch<UserItem>(id, { queued: undefined });
      this.builder.moveToEnd(id);
    }
  }

  private updateContextUsage(): void {
    const u = this.builder.lastUsage;
    if (!u) return;
    const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (!used) return;
    const max = this.contextWindow ?? (this.resolvedModel?.includes('[1m]') ? 1_000_000 : used > 200_000 ? 1_000_000 : 200_000);
    const next: ContextUsageView = { usedTokens: used, maxTokens: max, percent: Math.min(100, Math.round((used / max) * 100)) };
    if (JSON.stringify(next) === JSON.stringify(this.contextUsage)) return;
    this.contextUsage = next;
    this.patchUi({ contextUsage: next });
  }

  // ---------------------------------------------------------------------------
  // Control requests from the CLI
  // ---------------------------------------------------------------------------

  private onControlRequest(proc: ClaudeProcess, { requestId, request }: ControlRequestEvent): void {
    if (this.proc !== proc) return;
    this.lastActivityAt = Date.now();
    switch (request.subtype) {
      case 'can_use_tool':
        void this.onCanUseTool(requestId, request as unknown as CanUseToolRequest);
        return;
      case 'elicitation': {
        const r = request as Record<string, unknown>;
        const mode = r.mode === 'url' ? 'url' : 'form';
        const serverName = String(r.mcp_server_name ?? 'An MCP server');
        const view: ElicitationRequestView = {
          kind: 'elicitation',
          requestId,
          serverName,
          title: sanitizeDisplay(typeof r.title === 'string' ? r.title : typeof r.display_name === 'string' ? r.display_name : undefined),
          message: sanitizeDisplay(String(r.message ?? '')) ?? '',
          mode,
          url: typeof r.url === 'string' ? r.url : undefined,
          fields: mode === 'form' ? fieldsFromSchema(r.requested_schema, Array.isArray(r.property_order) ? (r.property_order as string[]) : undefined) : [],
          createdAt: Date.now(),
        };
        this.pending.set(requestId, { view });
        this.patchUi({ pending: this.pendingRequests });
        this.setStatus('waiting');
        this.flush();
        this._onDidChange.fire();
        this._onNeedsAttention.fire({ reason: 'input', detail: `${view.title ?? serverName}: ${clip(view.message || 'needs your input', 120)}` });
        return;
      }
      case 'request_user_dialog':
        // We declare no dialog kinds, so the CLI should never send one; answering would settle it wrongly.
        this.log.warn(`unexpected request_user_dialog ${String((request as Record<string, unknown>).dialog_kind)}`);
        return;
      default:
        proc.respondError(requestId, `Unsupported request: ${request.subtype}`);
        return;
    }
  }

  private async onCanUseTool(requestId: string, req: CanUseToolRequest): Promise<void> {
    const createdAt = Date.now();
    let view: PendingRequestView;
    if (req.tool_name === 'AskUserQuestion') {
      const questions = Array.isArray(req.input.questions) ? (req.input.questions as Array<Record<string, unknown>>) : [];
      view = {
        kind: 'question',
        requestId,
        toolUseId: req.tool_use_id,
        createdAt,
        questions: questions.map(
          (q): QuestionView => ({
            question: String(q.question ?? ''),
            header: typeof q.header === 'string' ? q.header : undefined,
            multiSelect: q.multiSelect === true,
            options: (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []).map((o) => ({
              label: String(o.label ?? ''),
              description: typeof o.description === 'string' ? o.description : undefined,
              preview: typeof o.preview === 'string' ? o.preview : undefined,
            })),
          }),
        ),
      };
    } else if (req.tool_name === 'ExitPlanMode') {
      let plan = typeof req.input.plan === 'string' ? req.input.plan : '';
      const planFilePath = typeof req.input.planFilePath === 'string' ? req.input.planFilePath : undefined;
      if (!plan && planFilePath) plan = await readFile(planFilePath, 'utf8').catch(() => '');
      view = { kind: 'plan', requestId, toolUseId: req.tool_use_id, plan: plan || '(The plan is empty.)', planFilePath, createdAt };
    } else {
      view = {
        kind: 'permission',
        requestId,
        toolUseId: req.tool_use_id,
        toolName: req.tool_name,
        displayName: req.display_name && req.display_name !== req.tool_name ? req.display_name : undefined,
        title: sanitizeDisplay(req.title),
        description: sanitizeDisplay(req.description),
        input: req.input ?? {},
        options: permissionOptions(req.permission_suggestions, this.cwd, req.suppress_always_allow_rule),
        blockedPath: req.blocked_path,
        decisionReason: sanitizeDisplay(req.decision_reason),
        defaultToNo: req.default_to_no,
        createdAt,
      };
    }
    this.pending.set(requestId, { view, raw: req });
    this.builder.setToolStatus(req.tool_use_id, 'waiting-permission');
    this.patchUi({ pending: this.pendingRequests });
    this.setStatus('waiting');
    this.flush();
    this._onDidChange.fire();
    const reason = view.kind === 'permission' ? 'permission' : view.kind === 'question' ? 'question' : 'plan';
    const detail =
      view.kind === 'permission'
        ? `${view.displayName ?? view.toolName}${describeTarget(view.toolName, view.input)}`
        : view.kind === 'question'
          ? view.questions[0]?.question
          : 'Plan ready for review';
    this._onNeedsAttention.fire({ reason, detail });
  }

  private onControlCancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (entry.raw) this.builder.setToolStatus(entry.raw.tool_use_id, 'interrupted');
    this.patchUi({ pending: this.pendingRequests });
    if (this.pending.size === 0 && this.status === 'waiting') this.setStatus(this.turnStartedAt ? 'running' : 'idle');
    this.flush();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    void this.stopProcess();
    this._onDidChange.dispose();
    this._onUiMessage.dispose();
    this._onNeedsAttention.dispose();
  }
}

type SystemFrame = Omit<Partial<SdkSystemInit>, 'subtype'> & { subtype: string; [k: string]: unknown };

const EFFORT_NAMES: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };

function describeTarget(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return `: ${clip(input.command, 100)}`;
  if (typeof input.file_path === 'string') return `: ${input.file_path.split('/').pop()}`;
  if (typeof input.url === 'string') return `: ${input.url}`;
  return '';
}

function lastMeaningfulLine(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('at ') && !/^\s*$/.test(l));
  return lines.length ? clip(lines[lines.length - 1], 300) : undefined;
}
