// Trigger mode: the recorder lives in the database (sql/recorder.sql) and captures every change as it happens.
import { readFile } from 'node:fs/promises';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { splitSteps } from './autosteps.js';
import { loadColumns } from './catalog.js';
import { orderColumns, tableKey, type Change, type Marker, type Recording, type SessionSummary, type Step } from './types.js';

const INSTALL_SQL = new URL('../../sql/recorder.sql', import.meta.url);

export interface ActiveSession {
  id: string;
  name: string;
  startedAt: Date;
  stepSeq: number;
  stepName: string;
  paused: boolean;
  /** Auto steps: the quiet gap (ms) that ends a step, or null when steps are typed. */
  autoSplitMs: number | null;
}

export interface TriggerStatus {
  installed: boolean;
  /** Installed by an older version, without pause, resume and flag: installing again upgrades it. */
  outdated: boolean;
  watchedTables: number;
  excludedTables: string[];
  active: ActiveSession | null;
}

/** Installs or upgrades the recorder; returns how many tables got a trigger. */
export async function install(db: Db): Promise<number> {
  const sql = await readFile(INSTALL_SQL, 'utf8');
  await db.query('BEGIN');
  try {
    await db.query(sql);
    const { rows } = await db.query<{ n: number }>('SELECT _propmaster.attach_triggers() AS n');
    // Idle unless a session is running (an upgrade can happen mid-session).
    await db.query('SELECT _propmaster.set_triggers_enabled((SELECT session_id IS NOT NULL FROM _propmaster.state))');
    await db.query('COMMIT');
    return rows[0]!.n;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

export async function uninstall(db: Db): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS _propmaster CASCADE');
}

export async function isInstalled(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT to_regnamespace('_propmaster') IS NOT NULL AS ok");
  return rows[0]!.ok;
}

async function requireInstalled(db: Db): Promise<void> {
  if (!(await isInstalled(db))) {
    throw new UserError(
      'The recorder is not installed in this database.',
      'Run `propmaster install`, or use `propmaster record start --snapshot` if you only have read access.');
  }
}

/** Starts a session. With `autoSplitMs`, steps are split at quiet gaps and named automatically. */
export async function start(db: Db, name: string, autoSplitMs?: number): Promise<string> {
  if (autoSplitMs !== undefined) await requireCurrent(db);
  else await requireInstalled(db);
  const { rows } = await db.query<{ id: string }>('SELECT _propmaster.start($1)::text AS id', [name]);
  if (autoSplitMs !== undefined) {
    await db.query('UPDATE _propmaster.sessions SET auto_split_ms = $2 WHERE id = $1', [rows[0]!.id, autoSplitMs]);
  }
  return rows[0]!.id;
}

export async function step(db: Db, name: string): Promise<number> {
  await requireInstalled(db);
  const { rows } = await db.query<{ seq: number }>('SELECT _propmaster.step($1) AS seq', [name]);
  return rows[0]!.seq;
}

/** True when the recorder has everything this version uses (pause, flags, auto steps). */
async function isCurrent(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(`
    SELECT to_regprocedure('_propmaster.set_paused(boolean)') IS NOT NULL
       AND to_regclass('_propmaster.step_names') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '_propmaster.sessions'::regclass AND attname = 'auto_split_ms') AS ok`);
  return rows[0]!.ok;
}

/** Pause, flags and auto steps arrived after the first release: an older install needs `propmaster install` again. */
async function requireCurrent(db: Db): Promise<void> {
  await requireInstalled(db);
  if (!(await isCurrent(db))) {
    throw new UserError('The recorder in this database is from an older version.', 'Upgrade it (recordings are kept): `propmaster install`, or Upgrade recorder on the Setup page.');
  }
}

export async function pause(db: Db): Promise<void> {
  await requireCurrent(db);
  await db.query('SELECT _propmaster.set_paused(true)');
}

export async function resume(db: Db): Promise<void> {
  await requireCurrent(db);
  await db.query('SELECT _propmaster.set_paused(false)');
}

export async function flag(db: Db, note: string): Promise<void> {
  await requireCurrent(db);
  await db.query('SELECT _propmaster.flag($1)', [note]);
}

export async function stop(db: Db): Promise<string> {
  await requireInstalled(db);
  const { rows } = await db.query<{ id: string }>('SELECT _propmaster.stop()::text AS id');
  return rows[0]!.id;
}

export async function status(db: Db): Promise<TriggerStatus> {
  if (!(await isInstalled(db))) return { installed: false, outdated: false, watchedTables: 0, excludedTables: [], active: null };

  const { rows: [counts] } = await db.query<{ n: number }>('SELECT _propmaster.watched_table_count() AS n');
  const { rows: excluded } = await db.query<{ name: string }>(
    "SELECT format('%s.%s', table_schema, table_name) AS name FROM _propmaster.excluded_tables ORDER BY 1");
  const { rows: [active] } = await db.query<ActiveSession>(`
    SELECT s.id::text AS id, s.name, s.started_at AS "startedAt", st.seq AS "stepSeq", st.name AS "stepName",
           coalesce((to_jsonb(x) ->> 'paused')::boolean, false) AS paused,  -- these work before an upgrade adds the columns
           (to_jsonb(s) ->> 'auto_split_ms')::int AS "autoSplitMs"
      FROM _propmaster.state x
      JOIN _propmaster.sessions s ON s.id = x.session_id
      JOIN _propmaster.steps st ON st.id = x.step_id`);

  const current = await isCurrent(db);

  return {
    installed: true,
    outdated: !current,
    watchedTables: counts!.n,
    excludedTables: excluded.map((r) => r.name),
    active: active ?? null,
  };
}

/** Stops watching a table (and removes its triggers). Accepts "table" or "schema.table". */
export async function excludeTable(db: Db, table: string): Promise<void> {
  await requireInstalled(db);
  await db.query('SELECT _propmaster.exclude_table($1::regclass)', [table]);
}

export async function includeTable(db: Db, table: string): Promise<void> {
  await requireInstalled(db);
  await db.query('SELECT _propmaster.include_table($1::regclass)', [table]);
}

/** The newest sessions first; `limit` null for all of them. */
export async function listSessions(db: Db, limit: number | null = 20): Promise<SessionSummary[]> {
  await requireInstalled(db);
  const { rows } = await db.query<SessionSummary>(`
    SELECT s.id::text AS id, 'trigger' AS mode, s.name,
           s.started_at AS "startedAt", s.stopped_at AS "stoppedAt",
           (SELECT count(*)::int FROM _propmaster.changes c WHERE c.session_id = s.id) AS "changeCount"
      FROM _propmaster.sessions s
     ORDER BY s.id DESC
     LIMIT $1`, [limit]);
  return rows;
}

/** Deletes one stopped session and its changes. */
export async function countSessions(db: Db): Promise<number> {
  await requireInstalled(db);
  return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM _propmaster.sessions')).rows[0]!.n;
}

/** Deletes one stopped session and its changes. */
export async function deleteSession(db: Db, id: string): Promise<void> {
  await requireInstalled(db);
  await db.query('SELECT _propmaster.delete_session($1::bigint)', [id]);
}

/** Deletes stopped sessions older than the interval (a Postgres interval such as '7 days'). */
export async function prune(db: Db, olderThan: string): Promise<number> {
  await requireInstalled(db);
  const { rows } = await db.query<{ n: number }>('SELECT _propmaster.prune($1::interval) AS n', [olderThan]);
  return rows[0]!.n;
}

/** Loads a session with its steps and changes. Without an id, loads the most recent session. */
export async function getRecording(db: Db, sessionId?: string): Promise<Recording | null> {
  await requireInstalled(db);

  const { rows: [session] } = await db.query<{
    id: string; name: string; startedAt: Date; stoppedAt: Date | null; startedBy: string; database: string; autoSplitMs: number | null;
  }>(`
    SELECT s.id::text AS id, s.name, s.started_at AS "startedAt", s.stopped_at AS "stoppedAt",
           s.started_by AS "startedBy", current_database() AS database,
           (to_jsonb(s) ->> 'auto_split_ms')::int AS "autoSplitMs"
      FROM _propmaster.sessions s
     WHERE $1::bigint IS NULL OR s.id = $1::bigint
     ORDER BY s.id DESC
     LIMIT 1`, [sessionId ?? null]);
  if (!session) return null;

  const { rows: steps } = await db.query<Omit<Step, 'changes'> & { id: string }>(`
    SELECT id::text AS id, seq, name, started_at AS "startedAt"
      FROM _propmaster.steps
     WHERE session_id = $1
     ORDER BY seq`, [session.id]);

  const { rows: changes } = await db.query<Change & { stepId: string }>(`
    SELECT id::int AS id, step_id::text AS "stepId",
           table_schema AS "tableSchema", table_name AS "tableName", op,
           row_key AS "rowKey", old_values AS "oldValues", new_values AS "newValues",
           changed_at AS "changedAt", txid::text AS txid, db_user AS "dbUser", app_name AS "appName",
           host(client_addr) AS "clientAddr"
      FROM _propmaster.changes
     WHERE session_id = $1
     ORDER BY id`, [session.id]);

  const hasMarkers = (await db.query<{ ok: boolean }>("SELECT to_regclass('_propmaster.markers') IS NOT NULL AS ok")).rows[0]!.ok;
  const { rows: markers } = hasMarkers
    ? await db.query<Marker & { stepId: string }>(`
        SELECT step_id::text AS "stepId", kind, note, created_at AS at
          FROM _propmaster.markers
         WHERE session_id = $1
         ORDER BY id`, [session.id])
    : { rows: [] };

  const tables = [...new Set(changes.map((c) => tableKey(c.tableSchema, c.tableName)))];

  const { autoSplitMs, ...info } = session;
  const rec = orderColumns({
    ...info,
    ...(autoSplitMs ? { autoSplitMs } : {}),
    mode: 'trigger',
    steps: steps.map(({ id, ...s }) => ({
      ...s,
      changes: changes.filter((c) => c.stepId === id).map(({ stepId: _, ...c }) => c),
      markers: markers.filter((m) => m.stepId === id).map(({ stepId: _, ...m }) => m),
    })),
    columns: await loadColumns(db, tables),
    notes: [],
  });
  if (!autoSplitMs) return rec;
  const hasNames = (await db.query<{ ok: boolean }>("SELECT to_regclass('_propmaster.step_names') IS NOT NULL AS ok")).rows[0]!.ok;
  const { rows: names } = hasNames
    ? await db.query<{ id: number; name: string }>('SELECT first_change_id::int AS id, name FROM _propmaster.step_names WHERE session_id = $1', [session.id])
    : { rows: [] };
  return splitSteps(rec, autoSplitMs, new Map(names.map((n) => [n.id, n.name])));
}

/** Gives a step a new name, typed or auto, while recording or afterwards. */
export async function renameStep(db: Db, sessionId: string, seq: number, name: string): Promise<void> {
  const rec = await getRecording(db, sessionId);
  if (!rec || rec.id !== sessionId) throw new UserError(`There is no session ${sessionId}.`, 'See `propmaster record list`.');
  const step = rec.steps.find((s) => s.seq === seq);
  if (!step) throw new UserError(`Session ${sessionId} has no step ${seq}.`, `Its steps are ${rec.steps.map((s) => s.seq).join(', ')}.`);

  const key = step.renameKey ?? { seq };
  if ('seq' in key) {
    await db.query('UPDATE _propmaster.steps SET name = $3 WHERE session_id = $1 AND seq = $2', [sessionId, key.seq, name]);
  } else {
    await requireCurrent(db);
    await db.query(`
      INSERT INTO _propmaster.step_names (session_id, first_change_id, name) VALUES ($1, $2, $3)
      ON CONFLICT (session_id, first_change_id) DO UPDATE SET name = excluded.name`, [sessionId, key.firstChangeId, name]);
  }
}
