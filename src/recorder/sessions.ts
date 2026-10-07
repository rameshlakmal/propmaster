// Session operations shared by the CLI and the web app, for both recording modes.
// Trigger sessions live in the database; snapshot sessions live in local files tied to a database identity.
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { DEFAULT_GAP_MS } from './autosteps.js';
import * as snapshot from './snapshot.js';
import * as trigger from './trigger.js';
import type { Mode, Recording, SessionSummary } from './types.js';

export interface ActiveSession {
  id: string;
  name: string;
  mode: Mode;
  startedAt: Date;
  stepSeq: number;
  stepName: string;
  /** Paused: the session is open, but changes aren't recorded. */
  paused: boolean;
  /** Auto steps: the quiet gap (ms) that ends a step, or null when steps are typed. */
  autoSplitMs: number | null;
}

export interface RecorderStatus {
  installed: boolean;
  /** The recorder in the database predates pause, resume and flag: installing again upgrades it. */
  outdated: boolean;
  watchedTables: number;
  excludedTables: string[];
  active: ActiveSession | null;
}

export interface StartOptions {
  snapshot?: boolean;
  exclude?: string[];
  maxRows?: number;
  /** Split steps at quiet gaps and name them (trigger mode). True for the default gap, or the gap in ms. */
  autoSteps?: boolean | number;
}

export interface Started {
  id: string;
  mode: Mode;
  /** Tables watched (trigger mode) or read (snapshot mode). */
  tables: number;
  /** Snapshot mode: tables left out because they are too big. */
  skipped: string[];
}

/** The snapshot session recording this database, if any. */
export async function activeSnapshotFor(identity: string) {
  const active = await snapshot.activeSnapshot();
  return active && active.identity === identity ? active : null;
}

export async function status(db: Db, identity: string): Promise<RecorderStatus> {
  const s = await trigger.status(db);
  const snap = await activeSnapshotFor(identity);
  const active: ActiveSession | null = snap
    ? { id: snap.id, name: snap.name, mode: 'snapshot', startedAt: snap.startedAt, stepSeq: snap.stepSeq, stepName: snap.stepName, paused: snap.paused, autoSplitMs: null }
    : s.active ? { ...s.active, mode: 'trigger' } : null;
  return { installed: s.installed, outdated: s.outdated, watchedTables: s.watchedTables, excludedTables: s.excludedTables, active };
}

export async function start(db: Db, identity: string, name: string, options: StartOptions = {}): Promise<Started> {
  const active = await activeSnapshotFor(identity);
  if (active) throw new UserError(`Snapshot session ${active.id} is already recording.`, 'Stop it first.');

  const gap = options.autoSteps === true ? DEFAULT_GAP_MS : typeof options.autoSteps === 'number' ? options.autoSteps : undefined;
  if (gap !== undefined && (!Number.isFinite(gap) || gap < 500 || gap > 600_000)) {
    throw new UserError('The quiet gap for auto steps must be between 0.5 and 600 seconds.');
  }
  if (options.snapshot) {
    if (gap !== undefined) throw new UserError('Auto steps need live recording (trigger mode).', 'Snapshot mode only sees changes when you add a step, so it cannot tell actions apart.');
    const s = await snapshot.startSnapshot(db, identity, name, { exclude: options.exclude, maxRows: options.maxRows });
    return { id: s.id, mode: 'snapshot', tables: s.tables, skipped: s.skipped };
  }
  if (options.exclude?.length) throw new UserError('Excluding tables at start is for snapshot mode.', 'In trigger mode, exclude tables once with `propmaster record exclude <table>`.');
  const id = await trigger.start(db, name, gap);
  return { id, mode: 'trigger', tables: (await trigger.status(db)).watchedTables, skipped: [] };
}

export async function step(db: Db, identity: string, name: string): Promise<number> {
  return (await activeSnapshotFor(identity)) ? snapshot.stepSnapshot(db, identity, name) : trigger.step(db, name);
}

export async function pause(db: Db, identity: string): Promise<void> {
  if (await activeSnapshotFor(identity)) await snapshot.pauseSnapshot(db, identity);
  else await trigger.pause(db);
}

export async function resume(db: Db, identity: string): Promise<void> {
  if (await activeSnapshotFor(identity)) await snapshot.resumeSnapshot(db, identity);
  else await trigger.resume(db);
}

/** Marks the current step ("this looks wrong"), with an optional note. */
export async function flag(db: Db, identity: string, note = ''): Promise<void> {
  if (await activeSnapshotFor(identity)) await snapshot.flagSnapshot(identity, note);
  else await trigger.flag(db, note);
}

export async function stop(db: Db, identity: string): Promise<Recording> {
  if (await activeSnapshotFor(identity)) return snapshot.stopSnapshot(db, identity);
  return (await trigger.getRecording(db, await trigger.stop(db)))!;
}

/** The newest sessions for this database, trigger sessions and local snapshot sessions together. */
export async function list(db: Db, identity: string, limit = 20): Promise<SessionSummary[]> {
  return (await page(db, identity, 0, limit)).sessions;
}

export interface SessionPage {
  sessions: SessionSummary[];
  /** Sessions in all, on every page. */
  total: number;
}

/** `limit` sessions after skipping `offset`, newest first. */
export async function page(db: Db, identity: string, offset: number, limit: number): Promise<SessionPage> {
  const installed = await trigger.isInstalled(db);
  // Enough of the newest from each source to fill this page once they are merged by start time.
  const fromDb = installed ? await trigger.listSessions(db, offset + limit) : [];
  const local = await snapshot.listSnapshots(identity);
  const merged = [...fromDb, ...local].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  const total = (installed ? await trigger.countSessions(db) : 0) + local.length;
  return { sessions: merged.slice(offset, offset + limit), total };
}

/** One session by id ("12" or "s3"), or the latest when no id is given. */
export async function load(db: Db, identity: string, id?: string): Promise<Recording> {
  if (id !== undefined) {
    const clean = id.replace(/^#/, '');
    let rec: Recording | null;
    if (/^s\d+$/.test(clean)) rec = await snapshot.getSnapshotRecording(clean);
    else if (/^\d+$/.test(clean)) rec = await trigger.getRecording(db, clean);
    else throw new UserError(`"${id}" is not a session id.`, 'Session ids look like 12 (trigger mode) or s3 (snapshot mode). See `propmaster record list`.');
    if (!rec) throw new UserError(`There is no session ${id}.`, 'See `propmaster record list`.');
    return rec;
  }
  const latest = (await list(db, identity))[0];
  if (!latest) throw new UserError('No sessions recorded yet.', 'Start one with `propmaster record start "My test"`.');
  return load(db, identity, latest.id);
}

export const MAX_STEP_NAME = 200;

/** Gives step `seq` of session `id` ("12" or "s3") a new name. */
export async function renameStep(db: Db, id: string, seq: number, name: string): Promise<void> {
  const clean = id.replace(/^#/, '');
  const text = name.trim().replace(/\s+/g, ' ');
  if (!text) throw new UserError('A step needs a name.');
  if (text.length > MAX_STEP_NAME) throw new UserError(`Step names are at most ${MAX_STEP_NAME} characters.`);
  if (!Number.isInteger(seq) || seq < 0) throw new UserError(`"${seq}" is not a step number.`, 'Steps are numbered 0, 1, 2… as in the timeline.');
  if (/^s\d+$/.test(clean)) await snapshot.renameSnapshotStep(clean, seq, text);
  else if (/^\d+$/.test(clean)) await trigger.renameStep(db, clean, seq, text);
  else throw new UserError(`"${id}" is not a session id.`, 'Session ids look like 12 (trigger mode) or s3 (snapshot mode).');
}

export async function remove(db: Db, id: string): Promise<void> {
  const clean = id.replace(/^#/, '');
  if (/^s\d+$/.test(clean)) await snapshot.deleteSnapshot(clean);
  else await trigger.deleteSession(db, clean);
}
