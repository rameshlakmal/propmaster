// Talks to the local Propmaster server. The secret token arrives once in the page URL (?token=...),
// is kept for this browser tab only, and is sent with every API call.
import type { ApiError } from './types';

const TOKEN_KEY = 'propmaster-token';

function token(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    // Keep the token out of the address bar and history, but keep the page (#sessions/12) the link points to.
    history.replaceState(null, '', location.pathname + location.hash);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export class RequestError extends Error {
  constructor(readonly status: number, readonly detail: ApiError) {
    super(detail.message);
  }
}

/** Fired once when the running server is from a different build than this page. */
export const STALE_SERVER_EVENT = 'propmaster:stale-server';
let staleReported = false;

function checkBuild(res: Response): void {
  const served = res.headers.get('X-Propmaster-Build');
  if (staleReported || !served || served === 'unknown' || served === __BUILD_ID__) return;
  staleReported = true;
  window.dispatchEvent(new CustomEvent(STALE_SERVER_EVENT, { detail: { pageIsNewer: served < __BUILD_ID__ } }));
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Propmaster-Token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  checkBuild(res);
  const data = await res.json().catch(() => ({ error: { message: `The server answered ${res.status}.` } }));
  if (!res.ok) throw new RequestError(res.status, data.error ?? { message: `The server answered ${res.status}.` });
  return data as T;
}

/** Downloads an export. Fetched with the token in a header (never in a link), then saved as a file. */
export async function downloadExport(sessionId: string, format: 'html' | 'md' | 'sql', masked: boolean): Promise<void> {
  const q = new URLSearchParams({ format, mask: masked ? '1' : '0' });
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export?${q}`, { headers: { 'X-Propmaster-Token': token() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new RequestError(res.status, data.error ?? { message: `The server answered ${res.status}.` });
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = `propmaster-session-${sessionId}.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** Call once at start-up so the token is moved out of the URL immediately. */
export function initToken(): boolean {
  return token().length > 0;
}
