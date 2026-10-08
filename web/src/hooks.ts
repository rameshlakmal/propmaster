import { useCallback, useEffect, useRef, useState } from 'react';
import { RequestError } from './api';
import type { ApiError } from './types';

export type Route =
  | { page: 'record' }
  | { page: 'sessions'; id?: string }
  | { page: 'rules' }
  | { page: 'find' }
  | { page: 'setup' };

function parseHash(): Route {
  const [page, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'sessions') return { page, id: id || undefined };
  if (page === 'rules' || page === 'find' || page === 'setup') return { page };
  return { page: 'record' };
}

/** Pages live in the URL hash, so the browser's back button and bookmarks work. */
export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (to) => { location.hash = to; }];
}

export function toError(err: unknown): ApiError {
  if (err instanceof RequestError) return err.detail;
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/**
 * Loads data, and again every `everyMs` while given. Keeps the last good data during a refresh.
 * `timers` is the window whose clock drives the polling: the floating window passes its own, because
 * the browser slows timers right down in a tab that's in the background.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], everyMs?: number, timers: Window = window) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const result = await loadRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(toError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!everyMs) return;
    const timer = timers.setInterval(() => void refresh(), everyMs);
    return () => timers.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, everyMs]);

  return { data, error, loading, refresh, setData };
}

/** Seconds since a moment, ticking once a second: "4m 12s". */
export function useElapsed(since: string | null, timers: Window = window): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = timers.setInterval(() => setNow(Date.now()), 1000);
    return () => timers.clearInterval(timer);
  }, [since, timers]);
  if (!since) return '';
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Follows the operating system's light or dark setting, live. */
export function useSystemAppearance(): 'light' | 'dark' {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return dark ? 'dark' : 'light';
}
