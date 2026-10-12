// Cleanup: undoing changes safely, on a shared test database.
//
// Three things are cleaned the same way, as a list of changes undone newest first:
// * a seed run: the rows it created are deleted (whatever the test did to them since);
// * a recorded session (Tool 1): rows the app inserted are deleted, updated columns are set back, and
//   deleted rows are inserted again, each only if the row still looks as the recording left it;
// * a backup: what a clean did is undone again (restore).
//
// Rows are found by primary key only. Rows others point at (dependents) and rows others have claimed block
// the clean unless the tester says otherwise. Everything runs in one transaction, and what is about to be
// changed is written to a backup file before it commits.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { parseJsonExact } from '../core/json.js';
import * as claims from '../finder/claims.js';
import { quoteIdent } from '../recorder/export/sql.js';
import type { Recording, Row } from '../recorder/types.js';
import * as runs from './runs.js';
import { asText } from './seed.js';
import { column, inColumnOrder, loadSchema, qualified, referencing, shortName, type ForeignKey, type Schema, type Table } from './schema.js';

/** One change to undo. INSERT is undone by deleting, UPDATE by setting the old values, DELETE by inserting. */
export interface UndoChange {
  /** schema.table */
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
  /** The primary key (before an UPDATE). */
  key: Row | null;
  /** DELETE: the whole row; UPDATE: the changed columns before. */
  old: Row | null;
  /** INSERT: the whole row; UPDATE: the changed columns after. */
  new: Row | null;
  /** Seed runs: delete the row whatever it holds now (the run created it; the test is expected to change it). */
  anyState?: boolean;
}

export interface Diff {
  column: string;
  from: unknown;
  to: unknown;
}

export type Action =
  | { op: 'delete'; table: string; key: Row; row: Row; why: 'seeded' | 'inserted'; changed: Diff[] }
  | { op: 'delete'; table: string; key: Row; row: Row; why: 'dependent'; via: string; depth: number }
  | { op: 'update'; table: string; key: Row; set: Row; current: Row; why: 'updated' }
  | { op: 'insert'; table: string; key: Row; row: Row; why: 'deleted' };

export interface Skip {
  table: string;
  key: Row | null;
  reason: 'gone' | 'conflict' | 'no-key' | 'truncate';
  detail: string;
}

export interface Claimed {
  table: string;
  key: Row;
  claim: claims.ClaimRow;
}

export type Target =
  | { kind: 'run'; runIds: string[] }
  | { kind: 'session'; recording: Recording }
  | { kind: 'restore'; file: string };

export interface CleanPlan {
  /** What is cleaned; 'mixed' for a run and a session together. */
  kind: Target['kind'] | 'mixed';
  /** "Run #42 · Customer with two orders", "Session #12 · Checkout", "Backup run-42-…json". */
  title: string;
  /** In the order they run: dependents first (deepest first), then the rest. */
  actions: Action[];
  skipped: Skip[];
  /** Live claims by other people on rows the clean would change. */
  claimed: Claimed[];
  /** Rows that point at rows being deleted but have no primary key, so they can't be deleted precisely. */
  unkeyedDependents: { table: string; via: string; count: number }[];
}

export interface CleanResult {
  plan: CleanPlan;
  applied: boolean;
  /** Where the backup was written (when applied). */
  backup: string | null;
  /** Claims on rows that were deleted, released along with them. */
  releasedClaims: number;
}

export interface CleanOptions {
  /** Change the data; without it, only the plan is returned. */
  apply?: boolean;
  /** Also delete rows the run or session didn't create that point at rows being deleted. */
  includeDependents?: boolean;
  /** Also change rows other testers have claimed. */
  force?: boolean;
  /** Who is cleaning: their own claims don't block. */
  by: string;
  /** host:port/database, stored in the backup so it is restored to the same database. */
  identity: string;
}

/** Most rows a clean will touch, dependents included; more is almost certainly not one test's data. */
export const MAX_ROWS = 10_000;

/** Where backups go: $PROPMASTER_BACKUPS, or ~/.propmaster/backups. */
export function backupDir(): string {
  return process.env.PROPMASTER_BACKUPS ?? join(homedir(), '.propmaster', 'backups');
}

const rowKey = (table: string, key: Row) => `${table}|${JSON.stringify(Object.keys(key).sort().map((k) => [k, asText(key[k])]))}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pick = (row: Row, columns: string[]): Row => Object.fromEntries(columns.map((c) => [c, row[c]]));

/** Columns whose current value differs from the expected one. */
function differences(expected: Row, current: Row): Diff[] {
  return Object.keys(expected).filter((c) => !same(expected[c], current[c])).map((c) => ({ column: c, from: expected[c], to: current[c] }));
}

// ---------- reading rows ----------

function keyMatch(table: Table, key: Row, offset = 0): { sql: string; values: (string | null)[] } {
  const cols = table.primaryKey;
  return {
    sql: cols.map((c, i) => `x.${quoteIdent(c)} = $${offset + i + 1}::${column(table, c)!.type}`).join(' AND '),
    values: cols.map((c) => asText(key[c])),
  };
}

class RowReader {
  private readonly state = new Map<string, Row | null>();

  constructor(private readonly db: Db, private readonly lock: boolean) {}

  /** The row as it is now, or as the planned actions so far will leave it. */
  async get(table: Table, key: Row): Promise<Row | null> {
    const k = rowKey(table.key, key);
    if (this.state.has(k)) return this.state.get(k)!;
    const m = keyMatch(table, key);
    const { rows } = await this.db.query<{ row: Row }>(`SELECT to_jsonb(x.*) AS row FROM ${qualified(table)} x WHERE ${m.sql}${this.lock ? ' FOR UPDATE' : ''}`, m.values);
    const row = rows[0] ? inColumnOrder(table, rows[0].row) : null;
    this.state.set(k, row);
    return row;
  }

  set(table: Table, key: Row, row: Row | null): void {
    this.state.set(rowKey(table.key, key), row);
  }
}

// ---------- planning ----------

/** Works out what undoing `changes` (newest first) would do, without changing anything. */
async function planUndo(db: Db, schema: Schema, changes: UndoChange[], lock: boolean): Promise<Pick<CleanPlan, 'actions' | 'skipped'>> {
  const reader = new RowReader(db, lock);
  const actions: Action[] = [];
  const skipped: Skip[] = [];

  for (const ch of changes) {
    const table = schema.tables.get(ch.table);
    if (!table) {
      skipped.push({ table: ch.table, key: ch.key, reason: 'gone', detail: 'the table no longer exists' });
      continue;
    }
    if (ch.op === 'TRUNCATE') {
      skipped.push({ table: ch.table, key: null, reason: 'truncate', detail: 'a TRUNCATE emptied the table; its rows were not recorded, so they can\'t be put back' });
      continue;
    }
    if (!table.primaryKey.length || !ch.key) {
      skipped.push({ table: ch.table, key: ch.key, reason: 'no-key', detail: 'the table has no primary key, so the row can\'t be found again' });
      continue;
    }

    if (ch.op === 'INSERT') {
      const current = await reader.get(table, ch.key);
      if (!current) {
        skipped.push({ table: ch.table, key: ch.key, reason: 'gone', detail: 'already deleted' });
      } else if (ch.anyState || differences(ch.new ?? {}, current).length === 0) {
        actions.push({ op: 'delete', table: ch.table, key: ch.key, row: current, why: ch.anyState ? 'seeded' : 'inserted', changed: differences(ch.new ?? {}, current) });
        reader.set(table, ch.key, null);
      } else {
        skipped.push({ table: ch.table, key: ch.key, reason: 'conflict', detail: `changed since: ${describeDiffs(differences(ch.new ?? {}, current))}` });
      }
    } else if (ch.op === 'UPDATE') {
      const after = { ...ch.key, ...pick(ch.new ?? {}, table.primaryKey.filter((c) => ch.new && c in ch.new)) };
      const current = await reader.get(table, after);
      const expected = ch.new ?? {};
      if (!current) {
        skipped.push({ table: ch.table, key: after, reason: 'conflict', detail: 'the row no longer exists' });
      } else if (differences(expected, current).length) {
        skipped.push({ table: ch.table, key: after, reason: 'conflict', detail: `changed again since: ${describeDiffs(differences(expected, current))}` });
      } else {
        const set = ch.old ?? {};
        actions.push({ op: 'update', table: ch.table, key: after, set, current: pick(current, Object.keys(set)), why: 'updated' });
        reader.set(table, after, null);
        reader.set(table, ch.key, { ...current, ...set });
      }
    } else {
      const current = await reader.get(table, ch.key);
      if (current) {
        skipped.push({ table: ch.table, key: ch.key, reason: 'conflict', detail: 'a row with this key exists again' });
      } else {
        actions.push({ op: 'insert', table: ch.table, key: ch.key, row: ch.old ?? {}, why: 'deleted' });
        reader.set(table, ch.key, ch.old);
      }
    }
  }
  return { actions, skipped };
}

export function describeDiffs(diffs: Diff[]): string {
  const show = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return diffs.map((d) => `${d.column} ${show(d.from)} → ${show(d.to)}`).join(', ');
}

/**
 * Rows the plan doesn't touch that point at rows it deletes, followed through foreign keys to any depth
 * (an order the app created for a seeded customer, and that order's items). Deleting the parents would
 * fail, or with ON DELETE CASCADE / SET NULL silently remove or change them.
 */
async function dependents(db: Db, schema: Schema, actions: Action[], lock: boolean): Promise<{ found: Action[]; unkeyed: CleanPlan['unkeyedDependents'] }> {
  const planned = new Set(actions.filter((a) => a.op !== 'insert').map((a) => rowKey(a.table, a.key)));
  const found: Action[] = [];
  const unkeyed = new Map<string, { table: string; via: string; count: number }>();
  let frontier = new Map<string, Row[]>();
  for (const a of actions) if (a.op === 'delete') frontier.set(a.table, [...(frontier.get(a.table) ?? []), a.row]);

  for (let depth = 1; frontier.size && depth <= 50; depth++) {
    const next = new Map<string, Row[]>();
    for (const [tableKey, parents] of frontier) {
      const parent = schema.tables.get(tableKey)!;
      for (const fk of referencing(schema, parent)) {
        const child = schema.tables.get(fk.table)!;
        for (const row of await childRows(db, child, fk, parent, parents, lock)) {
          const via = `${shortName(child.key)}.${fk.columns.join(', ')} → ${shortName(parent.key)}${fk.onDelete === 'cascade' || fk.onDelete === 'set null' ? ` (ON DELETE ${fk.onDelete.toUpperCase()})` : ''}`;
          if (!child.primaryKey.length) {
            const u = unkeyed.get(via) ?? { table: child.key, via, count: 0 };
            u.count++;
            unkeyed.set(via, u);
            continue;
          }
          const key = pick(row, child.primaryKey);
          const k = rowKey(child.key, key);
          if (planned.has(k)) continue;
          planned.add(k);
          found.push({ op: 'delete', table: child.key, key, row, why: 'dependent', via, depth });
          next.set(child.key, [...(next.get(child.key) ?? []), row]);
          if (found.length + actions.length > MAX_ROWS) {
            throw new UserError(`Cleaning would touch more than ${MAX_ROWS} rows, counting rows that point at them.`, 'That is more than one test\'s data: check the run or session.');
          }
        }
      }
    }
    frontier = next;
  }
  // Deepest first: children are deleted before the rows they point at.
  found.sort((a, b) => (b as { depth: number }).depth - (a as { depth: number }).depth);
  return { found, unkeyed: [...unkeyed.values()] };
}

/** Rows of `child` whose foreign key points at one of `parents`. */
async function childRows(db: Db, child: Table, fk: ForeignKey, parent: Table, parents: Row[], lock: boolean): Promise<Row[]> {
  const keys = parents.map((p) => fk.refColumns.map((c) => asText(p[c])));
  if (keys.some((k) => k.some((v) => v === null))) return [];
  const pairs = fk.columns.map((c, i) => `x.${quoteIdent(c)} = (r ->> ${i})::${column(parent, fk.refColumns[i]!)!.type}`).join(' AND ');
  const { rows } = await db.query<{ row: Row }>(`
    SELECT to_jsonb(x.*) AS row FROM ${qualified(child)} x
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements($1::jsonb) r WHERE ${pairs})${lock ? ' FOR UPDATE OF x' : ''}`, [JSON.stringify(keys)]);
  return rows.map((r) => inColumnOrder(child, r.row));
}

/** Live claims, by someone other than `by`, on rows the plan changes. */
async function claimedRows(db: Db, schema: Schema, actions: Action[], by: string): Promise<Claimed[]> {
  if (!(await claims.claimsExist(db))) return [];
  const out: Claimed[] = [];
  const byTable = new Map<string, Action[]>();
  for (const a of actions) if (a.op !== 'insert') byTable.set(a.table, [...(byTable.get(a.table) ?? []), a]);
  for (const [tableKey, list] of byTable) {
    const table = schema.tables.get(tableKey)!;
    if (table.primaryKey.length !== 1) continue;
    const held = await claims.activeKeys(db, tableKey);
    if (!held.size) continue;
    for (const a of list) {
      const claim = held.get(asText(a.key[table.primaryKey[0]!]) ?? '');
      if (claim && claim.claimedBy !== by) out.push({ table: tableKey, key: a.key, claim });
    }
  }
  return out;
}

// ---------- targets ----------

async function changesFor(db: Db, target: Target, identity: string): Promise<{ title: string; changes: UndoChange[] }> {
  if (target.kind === 'run') {
    if (!target.runIds.length) throw new UserError('Which run?', 'Give a run id (see `propmaster runs`).');
    const changes: UndoChange[] = [];
    const names: string[] = [];
    // Newest run first, and each run's rows newest first: children before parents.
    for (const id of [...target.runIds].sort((a, b) => Number(b) - Number(a))) {
      const run = await runs.get(db, id);
      if (run.cleanedAt) throw new UserError(`Run #${run.id} was already cleaned (by ${run.cleanedBy}).`, 'See the runs that still have data with: propmaster runs');
      names.push(`#${run.id}`);
      for (const r of (await runs.trackedRows(db, run.id)).reverse()) {
        changes.push({ table: r.table, op: 'INSERT', key: r.key, old: null, new: r.created, anyState: true });
      }
    }
    const single = target.runIds.length === 1 ? await runs.get(db, target.runIds[0]!) : null;
    return { title: single ? `Run #${single.id} · ${single.scenario}` : `Runs ${names.reverse().join(', ')}`, changes };
  }

  if (target.kind === 'session') {
    const rec = target.recording;
    if (!rec.stoppedAt) throw new UserError(`Session #${rec.id} is still recording.`, 'Stop it first: propmaster record stop');
    const changes = rec.steps.flatMap((s) => s.changes).sort((a, b) => b.id - a.id).map((c): UndoChange => ({
      table: `${c.tableSchema}.${c.tableName}`, op: c.op, key: c.rowKey, old: c.oldValues, new: c.newValues,
    }));
    return { title: `Session #${rec.id} · ${rec.name}`, changes };
  }

  const backup = await readBackup(target.file);
  if (backup.database !== identity) {
    throw new UserError(`This backup is from ${backup.database}, not ${identity}.`, 'Restore it with a connection to the database it came from.');
  }
  return { title: `Backup of ${backup.title}`, changes: [...backup.changes].reverse() };
}

/**
 * Plans a clean and, with `apply`, carries it out: one transaction, backup first. Several targets are
 * cleaned together, in the order given (undo a session, then delete the run's rows).
 */
export async function clean(db: Db, targets: Target | Target[], options: CleanOptions): Promise<CleanResult> {
  const list = Array.isArray(targets) ? targets : [targets];
  if (!list.length) throw new UserError('Nothing to clean.', 'Give a run (--run) or a recorded session (--session).');
  const schema = await loadSchema(db);
  const parts = [];
  for (const t of list) parts.push(await changesFor(db, t, options.identity));
  const title = parts.map((p) => p.title).join(' + ');
  const runIds = list.flatMap((t) => (t.kind === 'run' ? t.runIds : []));

  // A preview reads a consistent snapshot and changes nothing; applying locks every row it will touch.
  await db.query(options.apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const planned = await planUndo(db, schema, parts.flatMap((p) => p.changes), Boolean(options.apply));
    const deps = await dependents(db, schema, planned.actions, Boolean(options.apply));
    const actions = [...deps.found, ...planned.actions];
    const plan: CleanPlan = {
      kind: list.length === 1 ? list[0]!.kind : 'mixed', title, actions, skipped: planned.skipped,
      claimed: await claimedRows(db, schema, actions, options.by),
      unkeyedDependents: deps.unkeyed,
    };

    if (!options.apply) {
      await db.query('ROLLBACK');
      return { plan, applied: false, backup: null, releasedClaims: 0 };
    }
    refuseIfBlocked(plan, options);
    const done = await execute(db, schema, actions);
    const releasedClaims = await releaseClaimsOnDeleted(db, schema, done);
    const backup = done.length ? await writeBackup({ title, database: options.identity, by: options.by, changes: done }) : null;
    if (runIds.length) await runs.markCleaned(db, runIds, options.by);
    await db.query('COMMIT');
    return { plan, applied: true, backup, releasedClaims };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw explainCleanError(err);
  }
}

function refuseIfBlocked(plan: CleanPlan, options: CleanOptions): void {
  if (plan.unkeyedDependents.length) {
    const u = plan.unkeyedDependents[0]!;
    throw new UserError(`${u.count} row${u.count === 1 ? '' : 's'} of ${shortName(u.table)} point at rows being deleted (${u.via}), and that table has no primary key, so they can't be removed precisely.`,
      'Delete or re-point those rows yourself, then clean again.');
  }
  const deps = plan.actions.filter((a) => a.why === 'dependent');
  if (deps.length && !options.includeDependents) {
    const tables = [...new Set(deps.map((d) => shortName(d.table)))].join(', ');
    throw new UserError(`${deps.length} other row${deps.length === 1 ? '' : 's'} (${tables}) point at rows being deleted. They weren't created by this ${plan.kind === 'session' ? 'session' : plan.kind === 'restore' ? 'restore' : 'run'}, so they are left alone.`,
      'Look at the preview (run without --apply). To delete them too, add --include-dependents.');
  }
  if (plan.claimed.length && !options.force) {
    const c = plan.claimed[0]!;
    throw new UserError(`${plan.claimed.length} row${plan.claimed.length === 1 ? ' is' : 's are'} claimed by someone else (${shortName(c.table)} ${Object.values(c.key).map(asText).join(', ')} by ${c.claim.claimedBy}, claim #${c.claim.id}).`,
      'Ask them to release it, or add --force to clean anyway.');
  }
}

/** Carries out the actions in order; returns what was done, as changes a restore can undo. */
async function execute(db: Db, schema: Schema, actions: Action[]): Promise<UndoChange[]> {
  const done: UndoChange[] = [];
  const changedMeanwhile = (a: Action) => new UserError(`${shortName(a.table)} ${Object.values(a.key).map(asText).join(', ')} changed while cleaning, so nothing was changed.`, 'Look at the preview again, then clean again.');
  for (const a of actions) {
    const table = schema.tables.get(a.table)!;
    if (a.op === 'delete') {
      const m = keyMatch(table, a.key);
      const { rows } = await db.query<{ row: Row }>(`DELETE FROM ${qualified(table)} x WHERE ${m.sql} RETURNING to_jsonb(x.*) AS row`, m.values);
      if (!rows[0]) throw changedMeanwhile(a);
      done.push({ table: a.table, op: 'DELETE', key: a.key, old: rows[0].row, new: null });
    } else if (a.op === 'update') {
      const names = Object.keys(a.set);
      const sets = names.map((c, i) => `${quoteIdent(c)} = $${i + 1}::${column(table, c)!.type}`).join(', ');
      const m = keyMatch(table, a.key, names.length);
      const { rows } = await db.query<{ row: Row }>(`UPDATE ${qualified(table)} x SET ${sets} WHERE ${m.sql} RETURNING to_jsonb(x.*) AS row`, [...names.map((c) => asText(a.set[c])), ...m.values]);
      if (!rows[0]) throw changedMeanwhile(a);
      done.push({ table: a.table, op: 'UPDATE', key: a.key, old: a.current, new: a.set });
    } else {
      const names = Object.keys(a.row).filter((c) => { const col = column(table, c); return col && !col.generated; });
      const { rows } = await db.query<{ row: Row }>(`
        INSERT INTO ${qualified(table)} AS x (${names.map(quoteIdent).join(', ')}) OVERRIDING SYSTEM VALUE
        SELECT ${names.map((c) => `r.${quoteIdent(c)}`).join(', ')} FROM jsonb_populate_record(NULL::${qualified(table)}, $1::jsonb) r
        RETURNING to_jsonb(x.*) AS row`, [JSON.stringify(a.row)]);
      done.push({ table: a.table, op: 'INSERT', key: a.key, old: null, new: rows[0]!.row });
    }
  }
  return done;
}

/** A claim on a row that no longer exists only gets in the way: deleted rows lose their claims. */
async function releaseClaimsOnDeleted(db: Db, schema: Schema, done: UndoChange[]): Promise<number> {
  if (!(await claims.claimsExist(db))) return 0;
  const byTable = new Map<string, string[]>();
  for (const ch of done) {
    const table = schema.tables.get(ch.table);
    if (ch.op !== 'DELETE' || !ch.key || table?.primaryKey.length !== 1) continue;
    byTable.set(ch.table, [...(byTable.get(ch.table) ?? []), asText(ch.key[table.primaryKey[0]!]) ?? '']);
  }
  let released = 0;
  for (const [table, keys] of byTable) {
    const { rowCount } = await db.query('DELETE FROM _propmaster.claims WHERE table_name = $1 AND row_key = ANY($2::text[])', [table, keys]);
    released += rowCount ?? 0;
  }
  return released;
}

function explainCleanError(err: unknown): unknown {
  if (err instanceof UserError) return err;
  const e = err as { code?: string; message?: string; detail?: string; table?: string };
  switch (e.code) {
    case '23503':
      return new UserError(`A row couldn't be deleted because another row still points at it: ${e.detail ?? e.message}`, 'Nothing was changed. Look at the preview for rows that point at these ones.');
    case '23505':
      return new UserError(`A row couldn't be put back because one with the same key or unique value exists: ${e.detail ?? e.message}`, 'Nothing was changed.');
    case '55P03':
      return new UserError('Some of these rows are locked by another session (a long transaction?).', 'Nothing was changed. Try again in a moment.');
    case '42501':
      return new UserError(`Permission denied: ${e.message}.`, 'Nothing was changed. Your DB user needs DELETE (and INSERT/UPDATE to undo a session) on these tables.');
    default:
      return e.code && e.message ? new UserError(`Cleaning failed: ${e.message}.`, 'Nothing was changed.') : err;
  }
}

// ---------- backups ----------

export interface Backup {
  kind: 'propmaster-backup';
  version: 1;
  title: string;
  database: string;
  by: string;
  createdAt: string;
  /** What the clean did, in order. A restore undoes them newest first. */
  changes: UndoChange[];
}

async function writeBackup(b: Pick<Backup, 'title' | 'database' | 'by' | 'changes'>): Promise<string> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const file = join(dir, `${stamp}-${name}.json`);
  const backup: Backup = { kind: 'propmaster-backup', version: 1, createdAt: new Date().toISOString(), ...b };
  await writeFile(file, JSON.stringify(backup, null, 2), 'utf8');
  return file;
}

export async function readBackup(file: string): Promise<Backup> {
  const path = resolve(file);
  let data: Backup;
  try {
    data = parseJsonExact(await readFile(path, 'utf8')) as Backup; // exact numbers: 49.50 must still match 49.50
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new UserError(`Can't find the backup ${path}.`, `Backups are kept in ${backupDir()}`);
    throw new UserError(`${path} is not a Propmaster backup (it isn't valid JSON).`);
  }
  if (data?.kind !== 'propmaster-backup' || data.version !== 1 || !Array.isArray(data.changes)) {
    throw new UserError(`${path} is not a Propmaster backup.`);
  }
  return data;
}

export interface BackupInfo {
  file: string;
  title: string;
  database: string;
  createdAt: string;
  changes: number;
}

/** Backups in the backup folder, newest first. Files that aren't backups are left out. */
export async function listBackups(dir = backupDir()): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    try {
      const b = await readBackup(join(dir, name));
      out.push({ file: join(dir, name), title: b.title, database: b.database, createdAt: b.createdAt, changes: b.changes.length });
    } catch {
      // not a backup
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
