/**
 * Typed wrapper around acquireVsCodeApi() (which may only be called once per webview).
 */
interface VsCodeApi<S> {
  postMessage(message: unknown): void;
  getState(): S | undefined;
  setState(state: S): void;
}

declare function acquireVsCodeApi<S = unknown>(): VsCodeApi<S>;

let api: VsCodeApi<unknown> | undefined;

function getApi(): VsCodeApi<unknown> {
  if (!api) {
    api =
      typeof acquireVsCodeApi === 'function'
        ? acquireVsCodeApi()
        : // Outside VS Code (browser test harness): log messages and keep state in memory.
          (() => {
            let state: unknown;
            return {
              postMessage: (m: unknown) => {
                (window as unknown as { __posted?: unknown[] }).__posted?.push(m);
                console.debug('[postMessage]', m);
              },
              getState: () => state,
              setState: (s: unknown) => {
                state = s;
              },
            };
          })();
  }
  return api;
}

export function post<M>(message: M): void {
  getApi().postMessage(message);
}

export function getPersisted<S>(): S | undefined {
  return getApi().getState() as S | undefined;
}

export function setPersisted<S>(state: S): void {
  getApi().setState(state);
}

/** Subscribe to messages from the extension. Returns an unsubscribe function. */
export function onMessage<M>(handler: (m: M) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as M);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
