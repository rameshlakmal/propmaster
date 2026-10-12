// Seed runs: which scenario created which rows, so cleanup can remove exactly those rows.
// Stored in _propmaster.seed_runs and _propmaster.seeded_rows (sql/seeder.sql), created on the first seed.
import { readFile } from 'node:fs/promises';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import type { Row } from '../recorder/types.js';

const INSTALL_SQL = new URL('../../sql/seeder.sql', import.meta.url);

export interface Run {
  id: string;
  scenario: string;
  file: string | null;
  params: Record<string, string>;
  createdBy: string;
  note: string | null;
  createdAt: string;
  cleanedAt: string | null;
  cleanedBy: string | null;
  /** How many rows the run created. */
  rows: number;
  /** Rows per table, schema.table → count, in creation order. */
  tables: Record<string, number>;
}

export interface TrackedRow {
  seq: number;
  /** schema.table */
  table: string;
  key: Row;
  created: Row;
  alias: string | null;
}

export async function runsExist(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT to_regclass('_propmaster.seeded_rows') IS NOT NULL AS ok");
  return rows[0]!.ok;
}

/** Creates the run tables on first use. */
export async function ensureRuns(db: Db): Promise<void> {
  if (await runsExist(db)) return;
  try {
    await db.query(await readFile(INSTALL_SQL, 'utf8'));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42501') {
      throw new UserError("Your DB user may not create the _propmaster schema, so seeded rows can't be tracked for cleanup.",
        'Ask a DBA once for: GRANT CREATE ON DATABASE <db> TO <user>; or to run sql/seeder.sql for you.');
    }
    // Someone else created the schema or tables at the same moment.
    if (code === '23505' || code === '42P06' || code === '42P07') {
      if (await runsExist(db)) return;
      await db.query(await readFile(INSTALL_SQL, 'utf8'));
      return;
    }
    throw err;
  }
}

const SELECT = `
  SELECT r.id::text AS id, r.scenario, r.file, r.params, r.created_by AS "createdBy", r.note,
         to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
         to_char(r.cleaned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "cleanedAt",
         r.cleaned_by AS "cleanedBy",
         (SELECT count(*)::int FROM _propmaster.seeded_rows s WHERE s.run_id = r.id) AS rows,
         coalesce((SELECT json_object_agg(t.name, t.n ORDER BY t.first)
                     FROM (SELECT s.table_schema || '.' || s.table_name AS name, count(*)::int AS n, min(s.seq) AS first
                             FROM _propmaster.seeded_rows s WHERE s.run_id = r.id GROUP BY 1) t), '{}'::json) AS tables
    FROM _propmaster.seed_runs r`;

export interface ListOptions {
  /** Also list runs that have been cleaned. */
  includeCleaned?: boolean;
  by?: string;
  limit?: number;
}

export async function list(db: Db, options: ListOptions = {}): Promise<Run[]> {
  if (!(await runsExist(db))) return [];
  const where: string[] = [];
  const values: unknown[] = [];
  if (!options.includeCleaned) where.push('r.cleaned_at IS NULL');
  if (options.by) {
    values.push(options.by);
    where.push(`r.created_by = $${values.length}`);
  }
  values.push(options.limit ?? 50);
  const { rows } = await db.query<Run>(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT $${values.length}`, values);
  return rows;
}

const parseId = (id: string): string => {
  const clean = id.replace(/^#/, '');
  if (!/^\d+$/.test(clean)) throw new UserError(`"${id}" is not a run id.`, 'Run ids are the numbers in `propmaster runs`.');
  return clean;
};

export async function get(db: Db, id: string): Promise<Run> {
  const clean = parseId(id);
  if (!(await runsExist(db))) throw new UserError(`There is no seed run #${clean}.`, 'Nothing has been seeded in this database yet.');
  const { rows } = await db.query<Run>(`${SELECT} WHERE r.id = $1`, [clean]);
  if (!rows[0]) throw new UserError(`There is no seed run #${clean}.`, 'See the runs with: propmaster runs');
  return rows[0];
}

/** The rows a run created, in creation order. */
export async function trackedRows(db: Db, runId: string): Promise<TrackedRow[]> {
  const { rows } = await db.query<TrackedRow>(`
    SELECT seq, table_schema || '.' || table_name AS table, row_key AS key, created_values AS created, alias
      FROM _propmaster.seeded_rows WHERE run_id = $1 ORDER BY seq`, [runId]);
  return rows;
}

export async function markCleaned(db: Db, runIds: string[], by: string): Promise<void> {
  await db.query('UPDATE _propmaster.seed_runs SET cleaned_at = now(), cleaned_by = $2 WHERE id = ANY($1::bigint[])', [runIds, by]);
}

/** A restore put a run's rows back: it has data again, and can be cleaned again. */
export async function markRestored(db: Db, runIds: string[]): Promise<void> {
  if (!runIds.length || !(await runsExist(db))) return;
  await db.query('UPDATE _propmaster.seed_runs SET cleaned_at = NULL, cleaned_by = NULL WHERE id = ANY($1::bigint[])', [runIds]);
}
