/**
 * Logging that works both inside VS Code (LogOutputChannel) and in unit tests
 * (console). Core modules take a `Logger` instead of importing vscode.
 */
export interface Logger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: (m, ...a) => console.log('[info]', m, ...a),
  warn: (m, ...a) => console.warn('[warn]', m, ...a),
  error: (m, ...a) => console.error('[error]', m, ...a),
};

export const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
