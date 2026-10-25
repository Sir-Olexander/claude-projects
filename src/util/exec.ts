import { execFile, type ExecFileOptions } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null if the process was killed by a signal. */
  code: number | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Text written to stdin. */
  input?: string;
}

/**
 * Runs a program without a shell and resolves with its output. Never rejects
 * for a non-zero exit code (check `code`); rejects only when the program
 * cannot be started at all (ENOENT etc.).
 */
export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const options: ExecFileOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    };
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(error);
        return;
      }
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null) : 0;
      resolve({ stdout: out, stderr: err, code });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}
