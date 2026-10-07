// Session operations shared by the CLI and the web app, for both recording modes.
// Trigger sessions live in the database; snapshot sessions live in local files tied to a database identity.
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
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
    ? { id: snap.id, name: snap.name, mode: 'snapshot', startedAt: snap.startedAt, stepSeq: snap.stepSeq, stepName: snap.stepName, paused: snap.paused }
    : s.active ? { ...s.active, mode: 'trigger' } : null;
  return { installed: s.installed, outdated: s.outdated, watchedTables: s.watchedTables, excludedTables: s.excludedTables, active };
}

export async function start(db: Db, identity: string, name: string, options: StartOptions = {}): Promise<Started> {
  const active = await activeSnapshotFor(identity);
  if (active) throw new UserError(`Snapshot session ${active.id} is already recording.`, 'Stop it first.');

  if (options.snapshot) {
    const s = await snapshot.startSnapshot(db, identity, name, { exclude: options.exclude, maxRows: options.maxRows });
    return { id: s.id, mode: 'snapshot', tables: s.tables, skipped: s.skipped };
  }
  if (options.exclude?.length) throw new UserError('Excluding tables at start is for snapshot mode.', 'In trigger mode, exclude tables once with `propmaster record exclude <table>`.');
  const id = await trigger.start(db, name);
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

/** All sessions for this database, newest first: trigger sessions and local snapshot sessions together. */
export async function list(db: Db, identity: string): Promise<SessionSummary[]> {
  const fromDb = (await trigger.isInstalled(db)) ? await trigger.listSessions(db) : [];
  const local = await snapshot.listSnapshots(identity);
  return [...fromDb, ...local].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
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

export async function remove(db: Db, id: string): Promise<void> {
  const clean = id.replace(/^#/, '');
  if (/^s\d+$/.test(clean)) await snapshot.deleteSnapshot(clean);
  else await trigger.deleteSession(db, clean);
}
