/**
 * Minimal event emitter with the same shape as vscode.Event, so modules that
 * do not import `vscode` (and can be unit-tested in plain Node) can still
 * expose events that VS Code code consumes directly.
 */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => unknown>();
  private disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const d: Disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(d);
    return d;
  };

  fire(e: T): void {
    if (this.disposed) return;
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error('[claude-projects] event listener failed', err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  add<T extends Disposable>(d: T): T {
    this.items.push(d);
    return d;
  }
  dispose(): void {
    const items = this.items;
    this.items = [];
    for (const d of items.reverse()) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
  }
}

/** Calls fn at most once per `ms`, trailing edge. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const a = lastArgs!;
      lastArgs = undefined;
      fn(...a);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    lastArgs = undefined;
  };
  wrapped.flush = () => {
    if (timer && lastArgs) {
      clearTimeout(timer);
      timer = undefined;
      const a = lastArgs;
      lastArgs = undefined;
      fn(...a);
    }
  };
  return wrapped;
}
