// Snapshot mode, for testers with read-only access: at every step boundary the CLI reads every table
// in one consistent transaction, keeps the rows in a local file, and compares consecutive snapshots.
// It needs only SELECT. It can't see who made a change, and a row changed twice within one step shows
// once (inserted and deleted again within a step: not at all).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { parseJsonExact } from '../core/json.js';
import { loadColumns } from './catalog.js';
import { matchesTable } from './filter.js';
import { orderColumns, tableKey, type Change, type Marker, type Recording, type Row, type SessionSummary } from './types.js';

export const DEFAULT_MAX_ROWS = 50_000;

export interface SnapshotOptions {
  /** Table patterns to leave out, as in filters: "audit_log", "logs.*". */
  exclude?: string[];
  /** Tables with more rows than this are skipped (and named in the report). */
  maxRows?: number;
}

interface TableSnapshot {
  schema: string;
  table: string;
  /** Primary key columns, or null when there is none. */
  key: string[] | null;
  /** Each row as canonical jsonb text, so equal rows have equal text. */
  rows: string[];
}

interface Snapshot {
  takenAt: string;
  tables: TableSnapshot[];
  skipped: string[];
}

interface StoredSession {
  /** host:port/database: snapshots from another database are never compared. */
  identity: string;
  options: Required<SnapshotOptions>;
  recording: Recording;
  /** While paused nothing is compared: resuming takes a fresh snapshot to compare against. */
  paused?: boolean;
}

export interface ActiveSnapshot {
  id: string;
  name: string;
  identity: string;
  startedAt: Date;
  stepSeq: number;
  stepName: string;
  paused: boolean;
}

function home(): string {
  return process.env.PROPMASTER_HOME ?? join(process.cwd(), '.propmaster');
}

function dir(): string {
  return join(home(), 'snapshots');
}

const sessionFile = (id: string) => join(dir(), `${id}.json`);
const stateFile = (id: string) => join(dir(), `${id}.state.json`);
const activeFile = () => join(dir(), 'active.json');

/** Writes to a temporary file, then renames it into place: Ctrl+C or a crash never leaves half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, path);
}

function reviveDates(rec: Recording): Recording {
  return {
    ...rec,
    startedAt: new Date(rec.startedAt),
    stoppedAt: rec.stoppedAt ? new Date(rec.stoppedAt) : null,
    steps: rec.steps.map((s) => ({
      ...s,
      startedAt: new Date(s.startedAt),
      changes: s.changes.map((c) => ({ ...c, changedAt: new Date(c.changedAt) })),
      ...(s.markers ? { markers: s.markers.map((m) => ({ ...m, at: new Date(m.at) })) } : {}),
    })),
  };
}

async function readSession(id: string): Promise<StoredSession | null> {
  if (!existsSync(sessionFile(id))) return null;
  try {
    const stored = parseJsonExact(await readFile(sessionFile(id), 'utf8')) as StoredSession;
    return { ...stored, recording: reviveDates(stored.recording) };
  } catch {
    // Only possible for files from before atomic writes, or edited by hand: treat as missing.
    process.emitWarning(`Ignoring unreadable snapshot session file ${sessionFile(id)}`);
    return null;
  }
}

async function readActiveId(): Promise<string | null> {
  if (!existsSync(activeFile())) return null;
  return (JSON.parse(await readFile(activeFile(), 'utf8')) as { id: string }).id;
}

async function nextId(): Promise<string> {
  const files = existsSync(dir()) ? await readdir(dir()) : [];
  const ids = files.map((f) => /^s(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number);
  return `s${Math.max(0, ...ids) + 1}`;
}

/** Reads every visible table in one REPEATABLE READ transaction, so the snapshot is consistent. */
export async function takeSnapshot(db: Db, options: Required<SnapshotOptions>): Promise<Snapshot> {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const { rows: tables } = await db.query<{ schema: string; table: string; key: string[] | null }>(`
      SELECT n.nspname AS schema, c.relname AS table,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k (attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE i.indrelid = c.oid AND i.indisprimary) AS key
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'  -- partitions are read one by one, like trigger mode reports them
         AND n.nspname NOT IN ('information_schema', '_propmaster')
         AND n.nspname NOT LIKE 'pg\\_%'
         AND has_table_privilege(c.oid, 'SELECT')
       ORDER BY 1, 2`);

    const result: Snapshot = { takenAt: new Date().toISOString(), tables: [], skipped: [] };
    for (const t of tables) {
      if (matchesTable(options.exclude, t.schema, t.table)) continue;
      const from = `ONLY ${quote(t.schema)}.${quote(t.table)}`;

      const { rows: [count] } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${from} LIMIT ${options.maxRows + 1}) x`);
      if (count!.n > options.maxRows) {
        result.skipped.push(tableKey(t.schema, t.table));
        continue;
      }

      // Raw text, not parsed JSON: canonical jsonb text makes equal rows compare equal.
      const { rows } = await db.query<{ row: string }>(`SELECT to_jsonb(t.*)::text AS row FROM ${from} t`);
      result.tables.push({ ...t, rows: rows.map((r) => r.row) });
    }

    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function pickKey(row: Row, key: string[]): Row {
  return Object.fromEntries(key.map((k) => [k, row[k]]));
}

/** The changes between two snapshots of the same database. */
export function diffSnapshots(before: Snapshot, after: Snapshot, firstId: number): Change[] {
  const changes: Omit<Change, 'id'>[] = [];
  const at = new Date(after.takenAt);
  const base = { txid: null, dbUser: null, appName: null, clientAddr: null, changedAt: at };
  const previous = new Map(before.tables.map((t) => [tableKey(t.schema, t.table), t]));

  for (const now of after.tables) {
    const was = previous.get(tableKey(now.schema, now.table));
    // A table skipped or missing earlier can't be compared; a brand-new table shows as inserts.
    if (!was && before.skipped.includes(tableKey(now.schema, now.table))) continue;
    const oldRows = was?.rows ?? [];
    const meta = { ...base, tableSchema: now.schema, tableName: now.table };

    if (now.key) {
      const key = now.key;
      const index = (texts: string[]) => new Map(texts.map((text) => {
        const row = parseJsonExact(text) as Row;
        return [JSON.stringify(pickKey(row, key)), { text, row }] as const;
      }));
      const oldByKey = index(oldRows);
      const newByKey = index(now.rows);

      for (const [k, n] of newByKey) {
        const o = oldByKey.get(k);
        if (!o) {
          changes.push({ ...meta, op: 'INSERT', rowKey: pickKey(n.row, key), oldValues: null, newValues: n.row });
        } else if (o.text !== n.text) {
          const cols = Object.keys(n.row).filter((c) => JSON.stringify(o.row[c]) !== JSON.stringify(n.row[c]));
          changes.push({
            ...meta, op: 'UPDATE', rowKey: pickKey(o.row, key),
            oldValues: Object.fromEntries(cols.map((c) => [c, o.row[c] ?? null])),
            newValues: Object.fromEntries(cols.map((c) => [c, n.row[c] ?? null])),
          });
        }
      }
      for (const [k, o] of oldByKey) {
        if (!newByKey.has(k)) changes.push({ ...meta, op: 'DELETE', rowKey: pickKey(o.row, key), oldValues: o.row, newValues: null });
      }
    } else {
      // No key: compare as multisets of whole rows.
      const counts = new Map<string, number>();
      for (const text of oldRows) counts.set(text, (counts.get(text) ?? 0) + 1);
      for (const text of now.rows) {
        const left = counts.get(text) ?? 0;
        if (left > 0) counts.set(text, left - 1);
        else changes.push({ ...meta, op: 'INSERT', rowKey: null, oldValues: null, newValues: parseJsonExact(text) as Row });
      }
      for (const [text, left] of counts) {
        for (let i = 0; i < left; i++) {
          changes.push({ ...meta, op: 'DELETE', rowKey: null, oldValues: parseJsonExact(text) as Row, newValues: null });
        }
      }
    }
  }

  return changes.map((c, i) => ({ ...c, id: firstId + i }));
}

function notesFor(snapshot: Snapshot, options: Required<SnapshotOptions>): string[] {
  const notes = ['Snapshot mode: changes are found by comparing tables at each step, so the DB user is unknown and a row changed twice within one step shows once.'];
  if (snapshot.skipped.length > 0) {
    notes.push(`Not watched (more than ${options.maxRows.toLocaleString('en')} rows): ${snapshot.skipped.join(', ')}.`);
  }
  return notes;
}

async function requireActive(identity: string): Promise<{ id: string; session: StoredSession }> {
  const id = await readActiveId();
  const session = id ? await readSession(id) : null;
  if (!id || !session) throw new UserError('Nothing is recording in snapshot mode.', 'Start with `propmaster record start --snapshot`.');
  if (session.identity !== identity) {
    throw new UserError(`Snapshot session ${id} is recording ${session.identity}, not ${identity}.`, 'Use the same --url, or stop that session first.');
  }
  return { id, session };
}

/** Compares the database with the last snapshot and adds the changes to the current step. */
async function captureStep(db: Db, id: string, session: StoredSession): Promise<void> {
  const before = parseJsonExact(await readFile(stateFile(id), 'utf8')) as Snapshot;
  const after = await takeSnapshot(db, session.options);
  const rec = session.recording;
  const last = rec.steps[rec.steps.length - 1]!;
  const firstId = rec.steps.reduce((n, s) => n + s.changes.length, 0) + 1;
  last.changes.push(...diffSnapshots(before, after, firstId));

  const tables = [...new Set(rec.steps.flatMap((s) => s.changes.map((c) => tableKey(c.tableSchema, c.tableName))))];
  rec.columns = { ...rec.columns, ...(await loadColumns(db, tables)) };
  rec.notes = notesFor(after, session.options);
  await writeJson(stateFile(id), after);
}

export async function startSnapshot(db: Db, identity: string, name: string, options: SnapshotOptions = {}): Promise<{ id: string; tables: number; skipped: string[] }> {
  const activeId = await readActiveId();
  if (activeId && !(await readSession(activeId))) await rm(activeFile(), { force: true }); // stale pointer
  else if (activeId) throw new UserError(`Snapshot session ${activeId} is already recording.`, 'Stop it first: `propmaster record stop`.');

  const opts = { exclude: options.exclude ?? [], maxRows: options.maxRows ?? DEFAULT_MAX_ROWS };
  const snapshot = await takeSnapshot(db, opts);
  const { rows: [who] } = await db.query<{ user: string; database: string }>('SELECT session_user AS user, current_database() AS database');
  const id = await nextId();
  const now = new Date(snapshot.takenAt);

  const session: StoredSession = {
    identity,
    options: opts,
    recording: {
      id, mode: 'snapshot', name, database: who!.database, startedAt: now, stoppedAt: null, startedBy: who!.user,
      steps: [{ seq: 0, name: '(before first step)', startedAt: now, changes: [] }],
      columns: {}, notes: notesFor(snapshot, opts),
    },
  };
  await writeJson(stateFile(id), snapshot);
  await writeJson(sessionFile(id), session);
  await writeJson(activeFile(), { id });
  return { id, tables: snapshot.tables.length, skipped: snapshot.skipped };
}

function addMarker(session: StoredSession, kind: Marker['kind'], note: string | null = null): void {
  const last = session.recording.steps[session.recording.steps.length - 1]!;
  (last.markers ??= []).push({ kind, note, at: new Date() });
}

/** Pausing finishes the current comparison, so what happened before the pause stays in the step. */
export async function pauseSnapshot(db: Db, identity: string): Promise<void> {
  const { id, session } = await requireActive(identity);
  if (session.paused) throw new UserError('The recording is already paused.');
  await captureStep(db, id, session);
  session.paused = true;
  addMarker(session, 'pause');
  await writeJson(sessionFile(id), session);
}

/** Resuming takes a fresh snapshot: whatever changed while paused is never reported. */
export async function resumeSnapshot(db: Db, identity: string): Promise<void> {
  const { id, session } = await requireActive(identity);
  if (!session.paused) throw new UserError('The recording is already running.');
  await writeJson(stateFile(id), await takeSnapshot(db, session.options));
  session.paused = false;
  addMarker(session, 'resume');
  await writeJson(sessionFile(id), session);
}

export async function flagSnapshot(identity: string, note: string): Promise<void> {
  const { id, session } = await requireActive(identity);
  addMarker(session, 'flag', note.trim() || null);
  await writeJson(sessionFile(id), session);
}

export async function stepSnapshot(db: Db, identity: string, name: string): Promise<number> {
  const { id, session } = await requireActive(identity);
  if (!session.paused) await captureStep(db, id, session);
  const seq = session.recording.steps.length;
  session.recording.steps.push({ seq, name, startedAt: new Date(), changes: [] });
  await writeJson(sessionFile(id), session);
  return seq;
}

export async function stopSnapshot(db: Db, identity: string): Promise<Recording> {
  const { id, session } = await requireActive(identity);
  if (!session.paused) await captureStep(db, id, session);
  session.paused = false;
  session.recording.stoppedAt = new Date();
  await writeJson(sessionFile(id), session);
  await rm(stateFile(id), { force: true });
  await rm(activeFile(), { force: true });
  return orderColumns(session.recording);
}

export async function activeSnapshot(): Promise<ActiveSnapshot | null> {
  const id = await readActiveId();
  const session = id ? await readSession(id) : null;
  if (!id || !session) return null;
  const last = session.recording.steps[session.recording.steps.length - 1]!;
  return { id, name: session.recording.name, identity: session.identity, startedAt: session.recording.startedAt, stepSeq: last.seq, stepName: last.name, paused: !!session.paused };
}

export async function getSnapshotRecording(id: string): Promise<Recording | null> {
  const session = await readSession(id);
  return session ? orderColumns(session.recording) : null;
}

export async function listSnapshots(identity: string): Promise<SessionSummary[]> {
  if (!existsSync(dir())) return [];
  const ids = (await readdir(dir())).map((f) => /^(s\d+)\.json$/.exec(f)?.[1]).filter((x): x is string => !!x);
  const sessions = await Promise.all(ids.map(readSession));
  return sessions
    .filter((s): s is StoredSession => s !== null && s.identity === identity)
    .map(({ recording: r }) => ({
      id: r.id, mode: 'snapshot' as const, name: r.name, startedAt: r.startedAt, stoppedAt: r.stoppedAt,
      changeCount: r.steps.reduce((n, s) => n + s.changes.length, 0),
    }))
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export async function deleteSnapshot(id: string): Promise<void> {
  if (!(await readSession(id))) throw new UserError(`There is no snapshot session ${id}.`);
  if ((await readActiveId()) === id) throw new UserError(`Snapshot session ${id} is still recording.`, 'Stop it first: `propmaster record stop`.');
  await rm(sessionFile(id), { force: true });
}
