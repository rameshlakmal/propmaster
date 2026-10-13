// The current test: what a tester is working on right now (TC-142 checkout), and everything they did for
// it on the active database, the claims, seed runs, recordings, rule checks and cleanup. It drives the
// Find → Seed → Record → Check → Clean stepper. It belongs to this tester and this browser, so it lives in
// localStorage, one per database.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface TestClaim {
  id: string;
  table: string;
  key: string;
}

export interface CurrentTest {
  name: string;
  startedAt: string;
  claims: TestClaim[];
  runs: string[];
  sessions: string[];
  checked: { sessionId: string | null; failed: number; passed: number; at: string } | null;
  cleanedAt: string | null;
}

export type StageId = 'find' | 'seed' | 'record' | 'check' | 'clean';
export type StageState = 'done' | 'active' | 'todo';

export interface Stage {
  id: StageId;
  label: string;
  route: string;
  state: StageState;
  detail: string;
}

interface Workspace {
  test: CurrentTest | null;
  start: (name: string) => void;
  rename: (name: string) => void;
  end: () => void;
  addClaims: (claims: TestClaim[]) => void;
  addRun: (runId: string) => void;
  addSession: (sessionId: string) => void;
  setChecked: (checked: NonNullable<CurrentTest['checked']>) => void;
  markCleaned: () => void;
}

const KEY = (profile: string) => `propmaster-test:${profile}`;
const EVENT = 'propmaster:test-changed';

function read(profile: string | null): CurrentTest | null {
  if (!profile) return null;
  try {
    const raw = localStorage.getItem(KEY(profile));
    return raw ? (JSON.parse(raw) as CurrentTest) : null;
  } catch {
    return null;
  }
}

function write(profile: string, test: CurrentTest | null): void {
  try {
    if (test) localStorage.setItem(KEY(profile), JSON.stringify(test));
    else localStorage.removeItem(KEY(profile));
  } catch {
    // storage blocked: the test lives for this page only
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: profile }));
}

const Ctx = createContext<Workspace | null>(null);

export function WorkspaceProvider({ profile, children }: { profile: string | null; children: ReactNode }) {
  const [test, setTest] = useState<CurrentTest | null>(() => read(profile));

  // Another database, another tab, or another part of this page changed it.
  useEffect(() => {
    setTest(read(profile));
    const sync = () => setTest(read(profile));
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [profile]);

  const update = useCallback((fn: (t: CurrentTest | null) => CurrentTest | null) => {
    if (!profile) return;
    const next = fn(read(profile));
    write(profile, next);
    setTest(next);
  }, [profile]);

  // Work done without a test started still counts: it starts one, named after the day.
  const ensure = (t: CurrentTest | null): CurrentTest => t ?? {
    name: `Test on ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
    startedAt: new Date().toISOString(), claims: [], runs: [], sessions: [], checked: null, cleanedAt: null,
  };

  const value = useMemo<Workspace>(() => ({
    test,
    start: (name) => update(() => ({ ...ensure(null), name: name.trim() || ensure(null).name })),
    rename: (name) => update((t) => (t ? { ...t, name: name.trim() || t.name } : t)),
    end: () => update(() => null),
    addClaims: (claims) => update((t) => {
      const cur = ensure(t);
      const known = new Set(cur.claims.map((c) => c.id));
      return { ...cur, claims: [...cur.claims, ...claims.filter((c) => !known.has(c.id))], cleanedAt: null };
    }),
    addRun: (runId) => update((t) => {
      const cur = ensure(t);
      return cur.runs.includes(runId) ? cur : { ...cur, runs: [...cur.runs, runId], cleanedAt: null };
    }),
    addSession: (sessionId) => update((t) => {
      const cur = ensure(t);
      return cur.sessions.includes(sessionId) ? cur : { ...cur, sessions: [...cur.sessions, sessionId], cleanedAt: null };
    }),
    setChecked: (checked) => update((t) => ({ ...ensure(t), checked })),
    markCleaned: () => update((t) => (t ? { ...t, cleanedAt: new Date().toISOString() } : t)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [test, update]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): Workspace {
  const ws = useContext(Ctx);
  if (!ws) throw new Error('useWorkspace outside WorkspaceProvider');
  return ws;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the test is: each stage done, happening now, or still to do. */
export function stagesOf(test: CurrentTest | null, recording: { name: string } | null): Stage[] {
  const t = test;
  const checked = t?.checked;
  return [
    { id: 'find', label: 'Find', route: 'find', state: t?.claims.length ? 'done' : 'todo',
      detail: t?.claims.length ? `${plural(t.claims.length, 'row')} claimed` : 'Claim data that fits' },
    { id: 'seed', label: 'Seed', route: 'seed', state: t?.runs.length ? 'done' : 'todo',
      detail: t?.runs.length ? `${plural(t.runs.length, 'run')} · #${t.runs.join(', #')}` : 'Or create exactly what you need' },
    { id: 'record', label: 'Record', route: 'record', state: recording ? 'active' : t?.sessions.length ? 'done' : 'todo',
      detail: recording ? `Recording “${recording.name}”` : t?.sessions.length ? `${plural(t.sessions.length, 'session')} · #${t.sessions.join(', #')}` : 'Capture what the app changes' },
    { id: 'check', label: 'Check', route: 'rules', state: checked ? 'done' : 'todo',
      detail: checked ? (checked.failed ? `${plural(checked.failed, 'rule')} broken` : `${plural(checked.passed, 'rule')} passed`) : 'Run business rules on it' },
    { id: 'clean', label: 'Clean', route: 'seed', state: t?.cleanedAt ? 'done' : 'todo',
      detail: t?.cleanedAt ? 'Tidied up' : 'Leave the database as you found it' },
  ];
}
