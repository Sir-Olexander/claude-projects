import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Emitter, type Event } from '../util/events';
import type { Logger } from '../util/log';
import { silentLogger } from '../util/log';
import type { PermissionMode } from '../shared/protocol';
import type { ControlRequestInner, InitializeResponse, SdkMessage, SdkUserMessageIn } from './sdkTypes';

/**
 * Drives one `claude` CLI process in headless stream-json mode — the same
 * protocol the Agent SDK and the official VS Code extension use:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *          --permission-prompt-tool=stdio ...
 *
 * stdin/stdout carry newline-delimited JSON. Besides conversation messages,
 * both sides exchange `control_request` / `control_response` frames (we send
 * initialize, interrupt, set_permission_mode…; the CLI sends can_use_tool when
 * it needs a permission decision).
 */

export interface ClaudeProcessOptions {
  cliPath: string;
  cwd: string;
  /** Resume this existing session. */
  resume?: string;
  /** Start a new session with this id. */
  sessionId?: string;
  /** With `resume`: continue under a new session id instead (`sessionId`, when given). */
  forkSession?: boolean;
  /** With `resume`: keep the conversation only up to this message uuid (included). */
  resumeSessionAt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  /** Reasoning effort for the session (--effort). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Lets the user switch to bypassPermissions later in the session. */
  allowDangerouslySkipPermissions?: boolean;
  /** Ask for thinking summaries in assistant messages. */
  thinkingDisplay?: 'summarized' | 'omitted';
  /** Stream partial assistant text (stream_event frames). Default true. */
  includePartialMessages?: boolean;
  /** Don't write a transcript (utility processes). */
  noSessionPersistence?: boolean;
  /** Skip user customizations: plugins, hooks, MCP servers… (utility processes). */
  safeMode?: boolean;
  /** Ignore all configured MCP servers. */
  strictMcpConfig?: boolean;
  /** PATH for the child (defaults to process.env.PATH). */
  pathEnv?: string;
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  log?: Logger;
}

export interface ControlRequestEvent {
  requestId: string;
  request: ControlRequestInner & Record<string, unknown>;
}

export interface ExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last lines of stderr, useful for error messages. */
  stderrTail: string;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

interface PendingControl {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  subtype: string;
}

export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly subtype: string,
  ) {
    super(message);
  }
}

/** Environment variables from the VS Code extension host that must not leak into Claude or the commands it runs. */
const STRIP_ENV = [/^VSCODE_/, /^ELECTRON_/, /^APPLICATION_INSIGHTS_/, /^NODE_OPTIONS$/, /^CLAUDECODE$/, /^CLAUDE_CODE_SSE_PORT$/, /^CLAUDE_CODE_ENTRYPOINT$/, /^ENABLE_IDE_INTEGRATION$/, /^CHROME_DESKTOP$/, /^ORIGINAL_XDG_CURRENT_DESKTOP$/];

export function buildChildEnv(base: NodeJS.ProcessEnv, opts: Pick<ClaudeProcessOptions, 'pathEnv' | 'extraEnv'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  if (opts.pathEnv) env.PATH = opts.pathEnv;
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1';
  if (base.TERM_PROGRAM === 'vscode') delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  Object.assign(env, opts.extraEnv ?? {});
  return env;
}

export function buildArgs(opts: ClaudeProcessOptions): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool=stdio'];
  if (opts.includePartialMessages !== false) args.push('--include-partial-messages');
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resume) {
    args.push('--resume', opts.resume);
    if (opts.forkSession) {
      args.push('--fork-session');
      if (opts.sessionId) args.push('--session-id', opts.sessionId);
    }
    if (opts.resumeSessionAt) args.push('--resume-session-at', opts.resumeSessionAt);
  } else if (opts.sessionId) {
    args.push('--session-id', opts.sessionId);
  }
  if (opts.allowDangerouslySkipPermissions) args.push('--allow-dangerously-skip-permissions');
  if (opts.thinkingDisplay) args.push('--thinking-display', opts.thinkingDisplay);
  if (opts.noSessionPersistence) args.push('--no-session-persistence');
  if (opts.safeMode) args.push('--safe-mode');
  if (opts.strictMcpConfig) args.push('--strict-mcp-config');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

const STDERR_TAIL_LINES = 40;

export class ClaudeProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly log: Logger;
  private readonly pending = new Map<string, PendingControl>();
  private stdoutBuf = '';
  private readonly decoder = new StringDecoder('utf8');
  private stderrLines: string[] = [];
  private exited = false;
  private exitPromise: Promise<ExitEvent> | undefined;

  private readonly _onMessage = new Emitter<SdkMessage>();
  /** Every conversation/system frame from the CLI (not control frames). */
  readonly onMessage: Event<SdkMessage> = this._onMessage.event;

  private readonly _onControlRequest = new Emitter<ControlRequestEvent>();
  /** Requests the CLI sends us (can_use_tool, elicitation, …). Answer with respond()/respondError(). */
  readonly onControlRequest: Event<ControlRequestEvent> = this._onControlRequest.event;

  private readonly _onControlCancel = new Emitter<string>();
  /** The CLI withdrew one of its control requests (request_id). */
  readonly onControlCancel: Event<string> = this._onControlCancel.event;

  private readonly _onExit = new Emitter<ExitEvent>();
  readonly onExit: Event<ExitEvent> = this._onExit.event;

  constructor(readonly options: ClaudeProcessOptions) {
    this.log = options.log ?? silentLogger;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  /** Spawns the CLI. Resolves once the process exists (not when it is ready). */
  start(): void {
    if (this.child) throw new Error('ClaudeProcess already started');
    const args = buildArgs(this.options);
    const env = buildChildEnv(process.env, this.options);
    this.log.info(`spawn ${this.options.cliPath} ${args.join(' ')} (cwd ${this.options.cwd})`);
    let resolveExit!: (e: ExitEvent) => void;
    this.exitPromise = new Promise((r) => (resolveExit = r));

    const child = spawn(this.options.cliPath, args, { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    const finish = (e: ExitEvent) => {
      if (this.exited) return;
      this.exited = true;
      const err = new Error(e.spawnError ?? `Claude exited (${e.code ?? e.signal})`);
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.log.info(`claude pid ${child.pid ?? '?'} exited code=${e.code} signal=${e.signal}${e.spawnError ? ' error=' + e.spawnError : ''}`);
      resolveExit(e);
      this._onExit.fire(e);
    };

    child.on('error', (err) => {
      finish({ code: null, signal: null, stderrTail: this.stderrTail(), spawnError: err.message });
    });
    child.on('exit', (code, signal) => {
      // Let stdout drain before reporting.
      setTimeout(() => finish({ code, signal, stderrTail: this.stderrTail() }), 50);
    });
    child.stdin.on('error', (err) => this.log.warn(`claude stdin error: ${err.message}`));
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift();
      }
      this.log.debug(`claude stderr: ${text.trimEnd()}`);
    });
  }

  waitForExit(): Promise<ExitEvent> {
    return this.exitPromise ?? Promise.resolve({ code: null, signal: null, stderrTail: '' });
  }

  stderrTail(): string {
    return this.stderrLines.join('\n');
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.debug(`claude non-JSON stdout: ${line.slice(0, 300)}`);
      return;
    }
    const type = msg.type;
    if (type === 'control_response') {
      const response = msg.response as { subtype?: string; request_id?: string; response?: Record<string, unknown>; error?: string } | undefined;
      const id = response?.request_id;
      const p = id ? this.pending.get(id) : undefined;
      if (!p || !id) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (response?.subtype === 'success') p.resolve(response.response ?? {});
      else p.reject(new ControlRequestError(response?.error ?? 'control request failed', p.subtype));
      return;
    }
    if (type === 'control_request') {
      const requestId = msg.request_id as string;
      const request = msg.request as ControlRequestEvent['request'];
      if (!requestId || !request) return;
      this._onControlRequest.fire({ requestId, request });
      return;
    }
    if (type === 'control_cancel_request') {
      const id = msg.request_id as string;
      if (id) this._onControlCancel.fire(id);
      return;
    }
    this._onMessage.fire(msg as unknown as SdkMessage);
  }

  private write(obj: unknown): boolean {
    if (!this.child || this.exited || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      this.log.warn(`claude write failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Sends a control request and resolves with the CLI's success payload. */
  request<T = Record<string, unknown>>(request: ControlRequestInner & Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.alive) {
        reject(new ControlRequestError('Claude is not running', request.subtype));
        return;
      }
      const p: PendingControl = { resolve: resolve as (v: Record<string, unknown>) => void, reject, subtype: request.subtype };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new ControlRequestError(`${request.subtype} timed out`, request.subtype));
        }, timeoutMs);
      }
      this.pending.set(requestId, p);
      if (!this.write({ type: 'control_request', request_id: requestId, request })) {
        this.pending.delete(requestId);
        if (p.timer) clearTimeout(p.timer);
        reject(new ControlRequestError('Claude is not accepting input', request.subtype));
      }
    });
  }

  /** Answers a control request the CLI sent us. */
  respond(requestId: string, response: Record<string, unknown>): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  respondError(requestId: string, error: string): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  }

  initialize(): Promise<InitializeResponse> {
    return this.request<InitializeResponse>({ subtype: 'initialize', hooks: null }, 90_000);
  }

  sendUserMessage(message: SdkUserMessageIn): boolean {
    return this.write(message);
  }

  async interrupt(): Promise<void> {
    await this.request({ subtype: 'interrupt' }, 15_000);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.request({ subtype: 'set_permission_mode', mode }, 15_000);
  }

  /**
   * Turns Remote Control on or off for this session: on, it can be continued
   * from claude.ai or the Claude app; the reply has the session's link.
   */
  async remoteControl(enabled: boolean): Promise<{ session_url?: string; connect_url?: string }> {
    return this.request<{ session_url?: string; connect_url?: string }>({ subtype: 'remote_control', enabled }, 60_000);
  }

  async setModel(model: string | null): Promise<void> {
    await this.request({ subtype: 'set_model', model }, 15_000);
  }

  /** Ends stdin so the CLI finishes and exits; kills it if it does not exit in time. */
  async close(graceMs = 3000): Promise<void> {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const exited = await Promise.race([this.waitForExit().then(() => true), delay(graceMs).then(() => false)]);
    if (exited) return;
    this.kill('SIGTERM');
    const exited2 = await Promise.race([this.waitForExit().then(() => true), delay(2000).then(() => false)]);
    if (!exited2) this.kill('SIGKILL');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!this.child || this.exited) return;
    try {
      this.child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
