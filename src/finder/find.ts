// Running a recipe: READ ONLY, with a time limit, so a recipe can never change data or hang a shared
// test database. Rows other testers have claimed are listed last and marked, never handed out.
import { displayTypes, type Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { quoteIdent, quoteLiteral } from '../recorder/export/sql.js';
import * as claims from './claims.js';
import { bind, bindNulls, type Recipe } from './recipes.js';

export type Row = Record<string, unknown>;

export interface FoundRow {
  values: Row;
  /** The claimed table's key value, when the recipe can claim. */
  key: string | null;
  /** A live claim on this row, by anyone. */
  claimedBy: claims.ClaimRow | null;
}

export interface ClaimTarget {
  /** schema.table */
  table: string;
  keyColumn: string;
  /** The result column holding the key. */
  column: string;
}

export interface FindResult {
  recipe: Pick<Recipe, 'id' | 'name' | 'file' | 'line'>;
  params: Record<string, string>;
  columns: string[];
  rows: FoundRow[];
  /** All rows the recipe matched, claimed ones included; when `moreMatches`, counting stopped here. */
  matches: number;
  /** True when there are more than MATCH_COUNT_LIMIT matches: counting all of them could take long. */
  moreMatches: boolean;
  /** How many of those someone holds right now. */
  claimed: number;
  claim: ClaimTarget | null;
  ms: number;
}

export interface FindOptions {
  params?: Record<string, string>;
  /** Rows to return (default 10). */
  limit?: number;
  /** Statement timeout (default '30s'). */
  timeout?: string;
}

/**
 * Matches are counted up to this many. An exact count reads every matching row, which on a big table
 * turns a 2 ms query into seconds; "1000+ matches" is all a tester needs to know.
 */
export const MATCH_COUNT_LIMIT = 1000;

const where = (recipe: Recipe) => `"${recipe.name}" (${recipe.file}, line ${recipe.line})`;

/** Turns Postgres errors from a recipe into something a tester can act on. */
export function explainRecipeError(err: unknown, recipe: Recipe, timeout: string): unknown {
  if (err instanceof UserError) return err;
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case '57014':
      return new UserError(`${where(recipe)} took longer than ${timeout}, so it was stopped.`, 'Make the query faster, or allow more time: --timeout 2m');
    case '25006':
      return new UserError(`${where(recipe)} tried to change data. Recipes may only read.`, "Write recipes as SELECT queries. Creating data is the Seeder's job.");
    case '22P02': case '22007': case '22008':
      return new UserError(`${where(recipe)}: ${e.message}.`, 'Check the parameter values (-p name=value).');
    default:
      return e.code && e.message ? new UserError(`${where(recipe)} failed: ${e.message}.`) : err;
  }
}

/** Two result columns with the same name can't be told apart (in a row, or as the claim key). */
function checkColumns(recipe: Recipe, columns: string[]): void {
  const twice = [...new Set(columns.filter((c, i) => columns.indexOf(c) !== i))];
  if (twice.length) {
    throw new UserError(`${where(recipe)} returns ${twice.length === 1 ? 'two columns' : 'columns'} named ${twice.map((c) => `"${c}"`).join(', ')}.`,
      `Give each column its own name, e.g. SELECT c.id, o.id AS order_id`);
  }
}

/** The claimed table, its key column, and the result column that holds the key. */
async function claimTarget(db: Db, recipe: Recipe, columns: string[]): Promise<ClaimTarget | null> {
  if (!recipe.claim) return null;
  const spec = recipe.claim;
  const t = await claims.keyedTable(db, spec.table).catch((err: unknown) => {
    throw err instanceof UserError ? new UserError(`${where(recipe)} claims ${spec.table} rows, but ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`, err.hint) : err;
  });
  const column = spec.via ?? t.keyColumn;
  if (!columns.includes(column)) {
    throw new UserError(
      `${where(recipe)} claims ${spec.table} rows, so its result needs the column "${column}". It has: ${columns.join(', ') || 'no columns'}.`,
      spec.via ? `Return the ${t.table} key as ${column}.` : `Select ${t.keyColumn}, or say which column holds it: -- claim: ${spec.table} via <column>`);
  }
  return { table: t.table, keyColumn: t.keyColumn, column };
}

/** Runs fn in a READ ONLY transaction with a statement timeout, then rolls back. */
async function readOnly<T>(db: Db, timeout: string, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN READ ONLY');
  try {
    await db.query(`SET LOCAL statement_timeout = ${quoteLiteral(timeout)}`);
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

/** Runs a recipe and returns its first rows, unclaimed ones first. */
export async function find(db: Db, recipe: Recipe, options: FindOptions = {}): Promise<FindResult> {
  const limit = options.limit ?? 10;
  const timeout = options.timeout ?? '30s';
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new UserError('The limit must be a whole number from 1 to 1000.');
  const { sql, values } = bind(recipe, options.params);
  const params = Object.fromEntries(recipe.params.map((p) => [p.name, options.params?.[p.name] ?? p.default ?? '']));
  const started = performance.now();

  try {
    return await readOnly(db, timeout, async () => {
      // The result's columns without running it (LIMIT 0), to check the claim column first.
      const shape = await db.query({ text: `SELECT * FROM (${sql}\n) r LIMIT 0`, values });
      const columns = shape.fields.map((f) => f.name);
      checkColumns(recipe, columns);
      const target = await claimTarget(db, recipe, columns);
      const held = target ? await claims.activeKeys(db, target.table) : new Map<string, claims.ClaimRow>();

      // Only the first rows are read: enough to count up to the limit even if every held row is among
      // them, plus one to tell "exactly the limit" from "more". The window counts see those rows;
      // row_number keeps the recipe's own ORDER BY within the unclaimed rows, which come first, and
      // claimed rows are only shown, marked, when there's room.
      const window = MATCH_COUNT_LIMIT + held.size + 1;
      const key = target ? `r.${quoteIdent(target.column)}::text` : 'NULL::text';
      const { rows } = await db.query<Row>({
        text: `
          SELECT * FROM (
            SELECT x.*, count(*) OVER () AS __pm_matches, count(*) FILTER (WHERE x.__pm_held) OVER () AS __pm_claimed
              FROM (
                SELECT r.*, ${key} AS __pm_key, coalesce(${key} = ANY ($${values.length + 1}::text[]), false) AS __pm_held,
                       row_number() OVER () AS __pm_n
                  FROM (SELECT * FROM (${sql}
                  ) q LIMIT ${window}) r
              ) x
          ) y
          ORDER BY y.__pm_held, y.__pm_n
          LIMIT ${limit}`,
        values: [...values, [...held.keys()]],
        types: displayTypes,
      });

      const first = rows[0];
      const counted = first ? Number(first.__pm_matches) : 0;
      return {
        recipe: { id: recipe.id, name: recipe.name, file: recipe.file, line: recipe.line },
        params,
        columns,
        rows: rows.map(({ __pm_key, __pm_held, __pm_n: _n, __pm_matches: _m, __pm_claimed: _c, ...values }) => ({
          values,
          key: (__pm_key as string | null) ?? null,
          claimedBy: __pm_held ? held.get(__pm_key as string) ?? null : null,
        })),
        matches: counted === window ? MATCH_COUNT_LIMIT : counted,
        moreMatches: counted === window,
        claimed: first ? Number(first.__pm_claimed) : 0,
        claim: target,
        ms: Math.round(performance.now() - started),
      };
    });
  } catch (err) {
    throw explainRecipeError(err, recipe, timeout);
  }
}

export interface ClaimOptions {
  /** How many rows to claim (default 1). */
  count?: number;
  by: string;
  note?: string;
  seconds: number;
}

/**
 * Claims the first free rows of a find result. If another tester claimed one in the meantime, the next
 * free row is taken instead; when none are left, it says so.
 */
export async function claimFound(db: Db, result: FindResult, opts: ClaimOptions): Promise<claims.ClaimRow[]> {
  if (!result.claim) {
    throw new UserError(`"${result.recipe.name}" can't claim rows: it has no "-- claim: <table>" line.`, 'Add one to the recipe, e.g. -- claim: customers');
  }
  const free = result.rows.filter((r) => !r.claimedBy && r.key !== null).map((r) => r.key!);
  const count = opts.count ?? 1;
  if (free.length === 0) {
    throw new UserError(result.matches === 0 ? 'Nothing to claim: the recipe found no rows.' : `Nothing to claim: all ${result.matches}${result.moreMatches ? '+' : ''} matching rows are claimed by others.`,
      result.matches === 0 ? 'Change the parameters, or create the data you need.' : 'See who holds them: propmaster claims');
  }
  const got = await claims.claim(db, { table: result.claim.table, keys: free, count, by: opts.by, recipe: result.recipe.name, note: opts.note, seconds: opts.seconds });
  if (got.length === 0) throw new UserError('Every free row was claimed by someone else just now.', 'Run it again to get the next ones.');
  return got;
}

// ---------- recipe checks (CI) ----------

export type CheckStatus = 'ok' | 'empty' | 'error';

export interface RecipeCheck {
  recipe: Pick<Recipe, 'id' | 'name' | 'file' | 'line'>;
  status: CheckStatus;
  /** How it was checked: run with the default parameters, or only planned (EXPLAIN) when one is required. */
  how: 'run' | 'explain';
  matches: number | null;
  ms: number;
  error?: string;
}

/**
 * Checks every recipe still works against this database: the SQL runs, the claim column is there, and it
 * still finds rows. Catches recipes broken by a schema change before a tester trips over them.
 */
export async function checkRecipes(db: Db, recipes: Recipe[], options: { timeout?: string } = {}): Promise<RecipeCheck[]> {
  const timeout = options.timeout ?? '30s';
  const results: RecipeCheck[] = [];
  for (const recipe of recipes) {
    const info = { id: recipe.id, name: recipe.name, file: recipe.file, line: recipe.line };
    const started = performance.now();
    const runnable = recipe.params.every((p) => p.default !== undefined);
    try {
      if (runnable) {
        const r = await find(db, recipe, { limit: 1, timeout });
        results.push({ recipe: info, status: r.matches > 0 ? 'ok' : 'empty', how: 'run', matches: r.matches, ms: Math.round(performance.now() - started) });
      } else {
        await readOnly(db, timeout, async () => {
          const { sql, values } = bindNulls(recipe);
          const shape = await db.query({ text: `SELECT * FROM (${sql}\n) r LIMIT 0`, values });
          const columns = shape.fields.map((f) => f.name);
          checkColumns(recipe, columns);
          await claimTarget(db, recipe, columns);
          await db.query({ text: `EXPLAIN ${sql}`, values });
        });
        results.push({ recipe: info, status: 'ok', how: 'explain', matches: null, ms: Math.round(performance.now() - started) });
      }
    } catch (err) {
      const e = explainRecipeError(err, recipe, timeout);
      const message = e instanceof Error ? e.message.replace(`${where(recipe)} failed: `, '').replace(`${where(recipe)} `, '') : String(e);
      results.push({ recipe: info, status: 'error', how: runnable ? 'run' : 'explain', matches: null, ms: Math.round(performance.now() - started), error: message });
    }
  }
  return results;
}
