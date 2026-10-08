// Claims: "I'm using customer #318 for the next 2 hours". Stored in _propmaster.claims (sql/finder.sql),
// so everyone on the same test database sees them. A claim expires by itself, so a forgotten one never
// blocks anyone for long. Claiming is atomic: two testers asking at once never get the same row.
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { quoteIdent } from '../recorder/export/sql.js';

const INSTALL_SQL = new URL('../../sql/finder.sql', import.meta.url);

export interface ClaimRow {
  id: string;
  table: string;
  key: string;
  claimedBy: string;
  recipe: string | null;
  note: string | null;
  claimedAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface ClaimRequest {
  /** schema.table */
  table: string;
  /** Candidate key values, best first: the first ones nobody holds are claimed. */
  keys: string[];
  /** How many rows to claim (default 1). */
  count?: number;
  by: string;
  recipe?: string;
  note?: string;
  /** How long the claim lasts, in seconds. */
  seconds: number;
}

/** Who is claiming: $PROPMASTER_USER, or the name you log in to your computer with. */
export function defaultClaimer(): string {
  const fromEnv = process.env.PROPMASTER_USER?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return 'tester';
  }
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** "2h", "30m", "1h30m", "1d" → seconds. */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+(\.\d+)?[smhd])+$/.test(t)) {
    throw new UserError(`"${text}" is not a duration.`, 'Use a number and a unit: 30m, 2h, 1h30m or 1d.');
  }
  let seconds = 0;
  for (const [, n, unit] of t.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) seconds += Number(n) * UNITS[unit!]!;
  if (seconds < 1) throw new UserError('A claim must last at least a second.');
  if (seconds > 30 * 86400) throw new UserError('A claim can last at most 30 days.', 'Claims are for test runs; release and claim again if you need longer.');
  return Math.round(seconds);
}

export async function claimsExist(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT to_regclass('_propmaster.claims') IS NOT NULL AS ok");
  return rows[0]!.ok;
}

/** Creates the claims table on first use. */
async function ensureClaims(db: Db): Promise<void> {
  if (await claimsExist(db)) return;
  try {
    await db.query(await readFile(INSTALL_SQL, 'utf8'));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42501') {
      throw new UserError('Your DB user may not create the _propmaster schema, so claims can\'t be stored.',
        'Finding works without it. To claim, ask a DBA once for: GRANT CREATE ON DATABASE <db> TO <user>; or to run sql/finder.sql for you.');
    }
    // Someone else created the schema or table at the same moment: unique violation, or duplicate schema/table.
    if (code === '23505' || code === '42P06' || code === '42P07') {
      if (await claimsExist(db)) return;
      await db.query(await readFile(INSTALL_SQL, 'utf8')); // the schema was theirs; the table is still missing
      return;
    }
    throw err;
  }
}

/** Key values of the rows in a table that someone holds right now. */
export async function activeKeys(db: Db, table: string): Promise<Map<string, ClaimRow>> {
  if (!(await claimsExist(db))) return new Map();
  const { rows } = await db.query<ClaimRow>(`${SELECT} WHERE table_name = $1 AND expires_at > now()`, [table]);
  return new Map(rows.map((r) => [r.key, r]));
}

const SELECT = `
  SELECT id::text AS id, table_name AS "table", row_key AS key, claimed_by AS "claimedBy", recipe, note,
         to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "claimedAt",
         to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
         expires_at <= now() AS expired
    FROM _propmaster.claims`;

/**
 * Claims the first `count` candidates nobody holds. An expired claim is taken over. Each row is one
 * INSERT ... ON CONFLICT statement, so a row another tester is claiming at the same moment is skipped.
 * A taken-over claim gets a new id: the old holder's `claims release <old id>` must not release it.
 */
export async function claim(db: Db, req: ClaimRequest): Promise<ClaimRow[]> {
  await ensureClaims(db);
  const want = req.count ?? 1;
  const got: ClaimRow[] = [];
  for (const key of req.keys) {
    if (got.length >= want) break;
    const { rows } = await db.query<{ id: string }>(`
      INSERT INTO _propmaster.claims AS c (table_name, row_key, claimed_by, recipe, note, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
      ON CONFLICT (table_name, row_key) DO UPDATE
         SET id = nextval(pg_get_serial_sequence('_propmaster.claims', 'id')), claimed_by = EXCLUDED.claimed_by, recipe = EXCLUDED.recipe, note = EXCLUDED.note,
             claimed_at = now(), expires_at = EXCLUDED.expires_at
       WHERE c.expires_at <= now()
      RETURNING id::text AS id`, [req.table, key, req.by, req.recipe ?? null, req.note ?? null, req.seconds]);
    if (rows[0]) got.push((await byIds(db, [rows[0].id]))[0]!);
  }
  return got;
}

async function byIds(db: Db, ids: string[]): Promise<ClaimRow[]> {
  const { rows } = await db.query<ClaimRow>(`${SELECT} WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  return rows;
}

export interface ListOptions {
  /** Also show claims that have run out (they are kept until the row is claimed again or they are cleared). */
  includeExpired?: boolean;
  by?: string;
}

export async function list(db: Db, options: ListOptions = {}): Promise<ClaimRow[]> {
  if (!(await claimsExist(db))) return [];
  const where: string[] = [];
  const values: unknown[] = [];
  if (!options.includeExpired) where.push('expires_at > now()');
  if (options.by) {
    values.push(options.by);
    where.push(`claimed_by = $${values.length}`);
  }
  const { rows } = await db.query<ClaimRow>(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY expires_at <= now(), claimed_at DESC, id DESC`, values);
  return rows;
}

const parseIds = (ids: string[]): string[] => ids.map((id) => {
  const clean = id.replace(/^#/, '');
  if (!/^\d+$/.test(clean)) throw new UserError(`"${id}" is not a claim id.`, 'Claim ids are the numbers in `propmaster claims`.');
  return clean;
});

export interface OwnerOptions {
  /** Who is asking. Another person's live claim is refused unless `force` is set. */
  by: string;
  force?: boolean;
}

const GONE = 'It may have been released, or have run out and been claimed by someone else (who then got a new claim id).';

/** Refuses to touch another person's live claim without `force`: it is usually a mistyped or stale id. */
function checkOwner(found: ClaimRow[], { by, force }: OwnerOptions, action: string): void {
  if (force) return;
  const theirs = found.filter((c) => c.claimedBy !== by && !c.expired);
  if (theirs.length) {
    const list = theirs.map((c) => `#${c.id} (${c.table.replace(/^public\./, '')} ${c.key}) is ${c.claimedBy}'s`).join(', ');
    throw new UserError(`Claim ${list}, not yours.`, `To ${action} it anyway, add --force.`);
  }
}

/** Releases claims by id. Returns the ones that were released. */
export async function release(db: Db, ids: string[], owner: OwnerOptions): Promise<ClaimRow[]> {
  const clean = parseIds(ids);
  if (!(await claimsExist(db))) throw new UserError(`There is no claim #${clean[0]}.`, GONE);
  const found = await byIds(db, clean);
  const missing = clean.filter((id) => !found.some((c) => c.id === id));
  if (missing.length) throw new UserError(`There is no claim ${missing.map((m) => `#${m}`).join(', ')}.`, `${GONE} See the current claims with: propmaster claims`);
  checkOwner(found, owner, 'release');
  // Only the claims as they were read: one taken over in the meantime has a new id and is left alone.
  await db.query('DELETE FROM _propmaster.claims WHERE id = ANY($1::bigint[])', [clean]);
  return found;
}

/** Releases every claim one person holds (and their expired ones). */
export async function releaseAllBy(db: Db, by: string): Promise<number> {
  if (!(await claimsExist(db))) return 0;
  const { rowCount } = await db.query('DELETE FROM _propmaster.claims WHERE claimed_by = $1', [by]);
  return rowCount ?? 0;
}

/** Deletes claims that have run out. They do no harm, but clutter `claims --all`. */
export async function clearExpired(db: Db): Promise<number> {
  if (!(await claimsExist(db))) return 0;
  const { rowCount } = await db.query('DELETE FROM _propmaster.claims WHERE expires_at <= now()');
  return rowCount ?? 0;
}

/**
 * Keeps a claim `seconds` longer: added to its current end, or to now if it has run out. A claim never
 * reaches more than 30 days ahead. An expired claim can be renewed only if nobody took the row since
 * (a taken-over claim has a new id).
 */
export async function extend(db: Db, id: string, seconds: number, owner: OwnerOptions): Promise<ClaimRow> {
  const [clean] = parseIds([id]);
  if (!(await claimsExist(db))) throw new UserError(`There is no claim #${clean}.`, GONE);
  const [found] = await byIds(db, [clean!]);
  if (!found) throw new UserError(`There is no claim #${clean}.`, GONE);
  checkOwner([found], owner, 'extend');
  const { rowCount } = await db.query(`
    UPDATE _propmaster.claims
       SET expires_at = least(greatest(expires_at, now()) + make_interval(secs => $2), now() + interval '30 days')
     WHERE id = $1`, [clean, seconds]);
  if (!rowCount) throw new UserError(`There is no claim #${clean}.`, GONE);
  return (await byIds(db, [clean!]))[0]!;
}

export interface KeyedTable {
  schema: string;
  name: string;
  /** schema.table, as stored in claims. */
  table: string;
  /** The single primary key column. */
  keyColumn: string;
}

/** Resolves a table as written (customers, billing.invoices) and finds its one-column primary key. */
export async function keyedTable(db: Db, name: string): Promise<KeyedTable> {
  const { rows } = await db.query<{ schema: string; table: string; keys: string[] | null }>(`
    SELECT n.nspname AS schema, c.relname AS table,
           (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM pg_index i
              CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k (attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = c.oid AND i.indisprimary) AS keys
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = to_regclass($1)`, [name]);
  const t = rows[0];
  if (!t) throw new UserError(`There is no table "${name}".`);
  if (!t.keys?.length) throw new UserError(`"${name}" has no primary key, so its rows can't be claimed.`);
  if (t.keys.length > 1) throw new UserError(`"${name}" has a primary key of ${t.keys.length} columns (${t.keys.join(', ')}); claims need a one-column key.`);
  return { schema: t.schema, name: t.table, table: `${t.schema}.${t.table}`, keyColumn: t.keys[0]! };
}

/** Claims one row by hand ("I'm testing with order 1042"), after checking it exists. */
export async function claimByKey(db: Db, tableName: string, key: string, opts: { by: string; note?: string; seconds: number }): Promise<ClaimRow> {
  const t = await keyedTable(db, tableName);
  const { rows } = await db.query(`SELECT 1 FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)} WHERE ${quoteIdent(t.keyColumn)}::text = $1`, [key]);
  if (!rows.length) throw new UserError(`${tableName} has no row with ${t.keyColumn} = ${key}.`);
  const [got] = await claim(db, { table: t.table, keys: [key], by: opts.by, note: opts.note, seconds: opts.seconds });
  if (!got) {
    const holder = (await activeKeys(db, t.table)).get(key);
    throw new UserError(`${tableName} ${key} is already claimed${holder ? ` by ${holder.claimedBy} (claim #${holder.id})` : ''}.`);
  }
  return got;
}
