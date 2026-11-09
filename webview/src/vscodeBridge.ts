// Typed wrapper around the VS Code webview API: the only channel to the extension host.
// acquireVsCodeApi() may be called once per webview, so every page shares this module.
import type { HostToWebview, WebviewToHost } from '@shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

/** Generic, page-typed channel. */
export function channel<Out, In>() {
  return {
    post: (message: Out) => api.postMessage(message),
    onMessage(handler: (message: In) => void): () => void {
      const listener = (event: MessageEvent) => {
        const data = event.data as { type?: unknown } | undefined;
        if (data && typeof data === 'object' && typeof data.type === 'string') handler(data as In);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}

export function loadState<T extends object>(): Partial<T> | undefined {
  const s = api.getState();
  return s && typeof s === 'object' ? (s as Partial<T>) : undefined;
}

export function saveState<T extends object>(state: T): void {
  api.setState(state);
}

// ---- Skill Tree page (kept for existing imports) --------------------------------------------

export interface PersistedUiState {
  query: string;
  source: string;
  category: string;
  view: 'graph' | 'list';
  selectedId: string | null;
  /** Within-category order: name, or by recorded use. */
  order?: 'name' | 'recent' | 'most';
  /** Recorded use from every project, or only this workspace's folders. */
  usageScope?: 'all' | 'here';
}

const graph = channel<WebviewToHost, HostToWebview>();
export const post = graph.post;
export const onMessage = graph.onMessage;
export const loadUiState = () => loadState<PersistedUiState>();
export const saveUiState = (s: PersistedUiState) => saveState(s);
