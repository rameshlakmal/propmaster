// Seeding: turns a scenario into rows, parents first, in one transaction, and tracks every row it creates
// under a run id so cleanup can remove exactly those rows later.
import { randomBytes } from 'node:crypto';
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { isRawNumber } from '../core/json.js';
import { quoteIdent } from '../recorder/export/sql.js';
import type { Row } from '../recorder/types.js';
import { generateValue } from './generate.js';
import { ensureRuns, runsExist } from './runs.js';
import { childSpecs, fillPlaceholders, isRef, Nested, paramValues, type RowSpec, type Scenario } from './scenarios.js';
import { closest, column, findTable, inColumnOrder, loadSchema, qualified, referencing, requireTable, shortName, type Column, type ForeignKey, type Schema, type Table } from './schema.js';

export interface CreatedRow {
  seq: number;
  /** schema.table */
  table: string;
  key: Row;
  values: Row;
  /** The scenario's name for the row ($as). */
  alias?: string;
  /** A parent made up because a required foreign key needed one; not written in the scenario. */
  auto: boolean;
}

export interface SeedResult {
  scenario: Pick<Scenario, 'id' | 'name' | 'file'>;
  params: Record<string, string>;
  /** The run id; null for a dry run. */
  runId: string | null;
  dryRun: boolean;
  rows: CreatedRow[];
  ms: number;
}

export interface SeedOptions {
  params?: Record<string, string>;
  /** Insert everything, report it, then roll back. */
  dryRun?: boolean;
  /** Who is seeding (shown in `propmaster runs`). */
  by: string;
  note?: string;
}

/** A scenario never needs this many rows; more means a mistake like $count: 1000 under $count: 1000. */
export const MAX_ROWS = 10_000;
const UNIQUE_RETRIES = 3;

/** Seeds a scenario. Everything happens in one transaction: it all works and is tracked, or nothing changes. */
export async function seed(db: Db, scenario: Scenario, options: SeedOptions): Promise<SeedResult> {
  const params = paramValues(scenario, options.params);
  const started = performance.now();
  if (!options.dryRun) await ensureRuns(db);
  const schema = await loadSchema(db);
  const tracking = options.dryRun ? await runsExist(db) : true;

  await db.query('BEGIN');
  try {
    let runId = '0';
    if (tracking) {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO _propmaster.seed_runs (scenario, file, params, created_by, note) VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id',
        [scenario.name, scenario.file, JSON.stringify(params), options.by, options.note ?? null]);
      runId = rows[0]!.id;
    }
    const seeder = new Seeder(db, schema, scenario, params, runId, tracking);
    for (const spec of scenario.seed) await seeder.insertSpec(spec, null, []);
    await db.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return {
      scenario: { id: scenario.id, name: scenario.name, file: scenario.file },
      params,
      runId: options.dryRun ? null : runId,
      dryRun: Boolean(options.dryRun),
      rows: seeder.rows,
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

interface Parent {
  table: Table;
  row: Row;
}

/** A value ready for Postgres: text to cast to the column's type, or NULL. */
type Text = string | null;

/** Turns a value from a row Postgres returned (or the scenario) into text for a bind parameter. */
export function asText(value: unknown): Text {
  if (value === null || value === undefined) return null;
  if (isRawNumber(value)) return value.rawJSON;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** A YAML list as a Postgres array literal: {"a","b"}. */
function arrayLiteral(items: unknown[]): string {
  return `{${items.map((v) => (v === null ? 'NULL' : Array.isArray(v) ? arrayLiteral(v) : `"${String(asText(v)).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;
}

class Seeder {
  readonly rows: CreatedRow[] = [];
  private readonly aliases = new Map<string, Parent>();
  private readonly nextInt = new Map<string, number>();
  private tokens = 0;

  constructor(
    private readonly db: Db,
    private readonly schema: Schema,
    private readonly scenario: Scenario,
    private readonly params: Record<string, string>,
    private readonly runId: string,
    private readonly tracking: boolean,
  ) {}

  private where(spec: { line: number }): string {
    return `${this.scenario.file}, line ${spec.line}`;
  }

  /** A short token unique to this run: r42n7x. A new one on every call. */
  private token(): string {
    this.tokens++;
    return `r${this.runId}n${this.tokens}${randomBytes(2).toString('hex').slice(0, 2)}`;
  }

  /** Inserts a spec's row(s), then each row's children. */
  /** `ancestors`: the rows this one is nested under, nearest last (customers, then orders). */
  async insertSpec(spec: RowSpec, parent: Parent | null, ancestors: Parent[]): Promise<void> {
    const table = requireTable(this.schema, spec.table);
    if (!table.primaryKey.length) {
      throw new UserError(`${this.where(spec)}: ${shortName(table.key)} has no primary key, so its rows couldn't be found again to clean up.`, 'Only tables with a primary key can be seeded.');
    }

    // Each key is a column of this table, or a child table.
    const given = new Map<string, unknown>();
    const children: { written: string; value: unknown }[] = [];
    for (const [key, value] of Object.entries(spec.fields)) {
      const col = column(table, key);
      if (col) {
        given.set(col.name, value instanceof Nested ? value.toJSON() : spec.exact?.[key] ?? value);
      } else if (findTable(this.schema, key)) {
        children.push({ written: key, value });
      } else {
        const options = [...table.columns.map((c) => c.name), ...referencing(this.schema, table).map((fk) => shortName(fk.table))];
        const close = closest(key, options);
        throw new UserError(`${this.where(spec)}: ${shortName(table.key)} has no column "${key}", and there is no table of that name.`,
          close ? `Did you mean "${close}"?` : `Its columns: ${table.columns.map((c) => c.name).join(', ')}`);
      }
    }

    const link = parent ? this.linkTo(table, parent, spec) : null;
    for (let n = 1; n <= spec.count; n++) {
      // Only rows made up to satisfy a foreign key can form a cycle; the rows a scenario nests (customers >
      // orders > order_items) can't, so a required link to a grandparent just gets a new row.
      const row = await this.insertRow(table, given, link && parent ? { fk: link, row: parent.row } : null, spec, n, [table.key], false, ancestors);
      if (spec.as) {
        if (this.aliases.has(spec.as)) throw new UserError(`${this.where(spec)}: two rows are named "${spec.as}".`, 'Each $as name must be unique in the scenario.');
        this.aliases.set(spec.as, { table, row });
        this.rows.at(-1)!.alias = spec.as;
      }
      for (const child of children) {
        for (const childSpec of childSpecs(child.written, child.value, spec.line, this.scenario.file)) {
          await this.insertSpec(childSpec, { table, row }, [...ancestors, { table, row }]);
        }
      }
    }
  }

  /** The foreign key that links a child table to its parent row: the only one, or the one named with $via. */
  private linkTo(table: Table, parent: Parent, spec: RowSpec): ForeignKey {
    const fks = table.foreignKeys.filter((fk) => fk.refTable === parent.table.key);
    const names = (list: ForeignKey[]) => list.map((fk) => fk.columns.join(', ')).join(' or ');
    if (spec.via) {
      const fk = fks.find((f) => f.columns.includes(spec.via!));
      if (!fk) throw new UserError(`${this.where(spec)}: ${shortName(table.key)}.${spec.via} is not a foreign key to ${shortName(parent.table.key)}.`, fks.length ? `Use $via: ${names(fks)}` : undefined);
      return fk;
    }
    if (fks.length === 1) return fks[0]!;
    if (fks.length === 0) {
      throw new UserError(`${this.where(spec)}: ${shortName(table.key)} rows are written under ${shortName(parent.table.key)}, but ${shortName(table.key)} has no foreign key to it.`,
        `Write ${shortName(table.key)} at the top level under seed:, or point at a row with { $ref: <name> }.`);
    }
    throw new UserError(`${this.where(spec)}: ${shortName(table.key)} has ${fks.length} foreign keys to ${shortName(parent.table.key)} (${names(fks)}).`, `Say which links these rows: $via: ${fks[0]!.columns[0]}`);
  }

  /** Builds and inserts one row; returns it as Postgres stored it. */
  private async insertRow(table: Table, given: Map<string, unknown>, link: { fk: ForeignKey; row: Row } | null, spec: { line: number }, n: number, chain: string[], auto: boolean, ancestors: Parent[] = []): Promise<Row> {
    if (this.rows.length >= MAX_ROWS) throw new UserError(`The scenario would create more than ${MAX_ROWS} rows.`, 'Check the $count values and the numbers of rows.');
    const values = new Map<string, Text>();
    const rowToken = this.token();
    const placeholders = { ...this.params, run: this.runId, n: String(n), unique: rowToken };

    // 1. Values from the scenario.
    for (const [name, raw] of given) {
      const col = column(table, name)!;
      if (col.generated) throw new UserError(`${this.where(spec)}: ${shortName(table.key)}.${col.name} is computed by the database and can't be set.`);
      if (isRef(raw)) {
        this.fillRef(table, col, raw.$ref, values, spec);
        continue;
      }
      values.set(col.name, this.toText(col, raw, placeholders, spec));
    }

    // 2. The link to the parent row this one is written under.
    if (link) {
      link.fk.columns.forEach((c, i) => {
        if (!values.has(c)) values.set(c, asText(link.row[link.fk.refColumns[i]!]));
      });
    }

    // 3. Required foreign keys nobody gave: a new parent row for each.
    for (const fk of table.foreignKeys) {
      if (fk.columns.some((c) => values.has(c))) continue;
      const cols = fk.columns.map((c) => column(table, c)!);
      if (!cols.some((c) => c.notNull && !c.hasDefault)) continue; // nullable, or filled by a default: leave it
      // A row this one is nested under, further up (order_items under customers > orders, with a required
      // customer_id): that is the row the scenario means.
      const ancestor = [...ancestors].reverse().find((a) => a.table.key === fk.refTable);
      if (ancestor) {
        fk.columns.forEach((c, i) => values.set(c, asText(ancestor.row[fk.refColumns[i]!])));
        continue;
      }
      if (fk.refTable === table.key || chain.includes(fk.refTable)) {
        throw new UserError(`${this.where(spec)}: ${shortName(table.key)}.${fk.columns.join(', ')} needs a ${shortName(fk.refTable)} row, which would need a ${shortName(table.key)} row first (a cycle).`,
          `Give ${fk.columns.join(', ')} a value: an existing key, or { $ref: <name> } of a row created earlier in the scenario.`);
      }
      const parentTable = this.schema.tables.get(fk.refTable)!;
      const parentRow = await this.insertRow(parentTable, new Map(), null, spec, this.rows.length + 1, [...chain, parentTable.key], true);
      fk.columns.forEach((c, i) => values.set(c, asText(parentRow[fk.refColumns[i]!])));
    }

    // 4. Made-up values for the remaining required columns (made again, with new tokens, after a unique clash).
    const fixed = new Set(values.keys());
    const made = new Set<string>();
    const fill = async () => {
      for (const col of table.columns) {
        if (fixed.has(col.name) || col.generated || col.hasDefault || col.identity || !col.notNull) continue;
        if (this.isUniqueInt(table, col)) await this.prefetchInt(table, col);
        values.set(col.name, generateValue(col, { table, n, token: () => this.token(), uniqueInt: (c) => this.takeInt(table, c) }));
        made.add(col.name);
      }
    };
    await fill();

    // 5. Insert. A unique clash on a made-up value is retried with new values.
    for (let attempt = 1; ; attempt++) {
      await this.db.query('SAVEPOINT pm_row');
      try {
        const row = await this.insert(table, values);
        await this.track(table, row, auto); // inside the savepoint: a failure here rolls back to it cleanly
        await this.db.query('RELEASE SAVEPOINT pm_row');
        return row;
      } catch (err) {
        await this.db.query('ROLLBACK TO SAVEPOINT pm_row');
        const e = err as { code?: string; constraint?: string };
        const clash = e.code === '23505' && table.uniques.some((u) => u.some((c) => made.has(c)));
        if (clash && attempt < UNIQUE_RETRIES) {
          await fill();
          continue;
        }
        throw this.explain(err, table, made, spec);
      }
    }
  }

  private async insert(table: Table, values: Map<string, Text>): Promise<Row> {
    const names = [...values.keys()];
    const cols = names.map((name) => column(table, name)!);
    const overriding = cols.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
    const text = names.length
      ? `INSERT INTO ${qualified(table)} AS x (${names.map(quoteIdent).join(', ')})${overriding} VALUES (${cols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')}) RETURNING to_jsonb(x.*) AS row`
      : `INSERT INTO ${qualified(table)} AS x DEFAULT VALUES RETURNING to_jsonb(x.*) AS row`;
    const { rows } = await this.db.query<{ row: Row }>(text, [...values.values()]);
    return inColumnOrder(table, rows[0]!.row);
  }

  private async track(table: Table, row: Row, auto: boolean): Promise<void> {
    const key = Object.fromEntries(table.primaryKey.map((c) => [c, row[c]]));
    const seq = this.rows.length + 1;
    if (this.tracking) {
      await this.db.query(
        'INSERT INTO _propmaster.seeded_rows (run_id, seq, table_schema, table_name, row_key, created_values) VALUES ($1, $2, $3, $4, $5, $6)',
        [this.runId, seq, table.schema, table.name, JSON.stringify(key), JSON.stringify(row)]);
    }
    this.rows.push({ seq, table: table.key, key, values: row, auto });
  }

  /** { $ref: name } on a column: the named row's key, through the foreign key the column belongs to. */
  private fillRef(table: Table, col: Column, name: string, values: Map<string, Text>, spec: { line: number }): void {
    const target = this.aliases.get(name);
    if (!target) {
      throw new UserError(`${this.where(spec)}: no row named "${name}" has been created yet.`,
        `Name a row with $as: ${name}, earlier in the scenario than where it is used.`);
    }
    const fk = table.foreignKeys.find((f) => f.columns.includes(col.name) && f.refTable === target.table.key);
    if (fk) {
      fk.columns.forEach((c, i) => values.set(c, asText(target.row[fk.refColumns[i]!])));
      return;
    }
    if (target.table.primaryKey.length !== 1) {
      throw new UserError(`${this.where(spec)}: ${shortName(table.key)}.${col.name} is not a foreign key to ${shortName(target.table.key)}, and that table's key has several columns.`);
    }
    values.set(col.name, asText(target.row[target.table.primaryKey[0]!]));
  }

  /** A scenario value as text: placeholders filled, lists as arrays (or JSON), objects as JSON. */
  private toText(col: Column, raw: unknown, placeholders: Record<string, string>, spec: { line: number }): Text {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return fillPlaceholders(raw, placeholders);
    if (Array.isArray(raw)) {
      if (col.category === 'A') return arrayLiteral(raw.map((v) => (typeof v === 'string' ? fillPlaceholders(v, placeholders) : v)));
      if (col.baseType === 'json' || col.baseType === 'jsonb') return JSON.stringify(raw);
      throw new UserError(`${this.where(spec)}: ${col.name} is ${col.type}, so it can't hold a list.`);
    }
    if (typeof raw === 'object') {
      if (col.baseType === 'json' || col.baseType === 'jsonb') return JSON.stringify(raw);
      throw new UserError(`${this.where(spec)}: ${col.name} is ${col.type}, so it can't hold ${JSON.stringify(raw)}.`, 'Only json and jsonb columns take a mapping. To point at another row, use { $ref: <name> }.');
    }
    return String(raw);
  }

  private isUniqueInt(table: Table, col: Column): boolean {
    return ['int2', 'int4', 'int8', 'numeric'].includes(col.baseType) && table.uniques.some((u) => u.length === 1 && u[0] === col.name);
  }

  /** The next free number of a unique integer column, read once per command. */
  private async prefetchInt(table: Table, col: Column): Promise<void> {
    const k = `${table.key}.${col.name}`;
    if (this.nextInt.has(k)) return;
    const { rows } = await this.db.query<{ next: string }>(`SELECT (coalesce(max(${quoteIdent(col.name)}), 0) + 1)::text AS next FROM ${qualified(table)}`);
    this.nextInt.set(k, Number(rows[0]!.next));
  }

  private takeInt(table: Table, column: string): number {
    const k = `${table.key}.${column}`;
    const n = this.nextInt.get(k) ?? 1;
    this.nextInt.set(k, n + 1);
    return n;
  }

  /** Postgres errors from an insert, as a message naming the table, column and what to change in the scenario. */
  private explain(err: unknown, table: Table, made: Set<string>, spec: { line: number }): unknown {
    if (err instanceof UserError) return err;
    const e = err as { code?: string; message?: string; column?: string; constraint?: string; detail?: string };
    const t = shortName(table.key);
    const at = this.where(spec);
    const madeUp = (c?: string) => (c && made.has(c) ? ' (a made-up value)' : '');
    switch (e.code) {
      case '23502':
        return new UserError(`${at}: ${t}.${e.column} can't be empty.`, `Give it a value in the scenario:  ${e.column}: <value>`);
      case '23503':
        return new UserError(`${at}: ${t} points at a row that doesn't exist: ${e.detail ?? e.message}`, 'Use an existing key, or { $ref: <name> } of a row created earlier in the scenario.');
      case '23505':
        return new UserError(`${at}: ${t} already has a row like this: ${e.detail ?? e.message}`, 'Make the value unique, e.g. with {{unique}} in it.');
      case '23514': {
        const check = table.checks.find((c) => c.name === e.constraint);
        const cols = check?.columns ?? [];
        return new UserError(`${at}: ${t} breaks the check "${e.constraint}"${cols.length ? ` on ${cols.join(', ')}${madeUp(cols[0])}` : ''}${check ? `: ${check.definition}` : ''}.`,
          `Give ${cols.length ? cols.join(' and ') : 'the column'} a value that passes it in the scenario.`);
      }
      case '22P02': case '22007': case '22008': case '22003': case '22001': case '23P01':
        return new UserError(`${at}: ${t}: ${e.message}.`, 'Check the values given in the scenario.');
      case '42501':
        return new UserError(`${at}: your DB user may not insert into ${t}.`, `Ask a DBA for: GRANT INSERT ON ${qualified(table)} TO <user>;`);
      default:
        return e.code && e.message ? new UserError(`${at}: inserting into ${t} failed: ${e.message}.`) : err;
    }
  }
}

// ---------- scenario checks (CI) ----------

export interface ScenarioCheck {
  scenario: Pick<Scenario, 'id' | 'name' | 'file'>;
  /** ok: it seeds; skipped: it needs a parameter with no default; error: it fails. */
  status: 'ok' | 'skipped' | 'error';
  rows: number;
  ms: number;
  error?: string;
}

/**
 * Seeds every scenario with its default parameters in a transaction that is rolled back: catches scenarios
 * broken by a migration (a renamed column, a new required column) before a tester trips over them.
 */
export async function checkScenarios(db: Db, scenarios: Scenario[]): Promise<ScenarioCheck[]> {
  const out: ScenarioCheck[] = [];
  for (const scenario of scenarios) {
    const info = { id: scenario.id, name: scenario.name, file: scenario.file };
    const started = performance.now();
    const missing = scenario.params.filter((p) => p.default === undefined).map((p) => p.name);
    if (missing.length) {
      out.push({ scenario: info, status: 'skipped', rows: 0, ms: 0, error: `needs ${missing.join(', ')}` });
      continue;
    }
    try {
      const r = await seed(db, scenario, { by: 'check', dryRun: true });
      out.push({ scenario: info, status: 'ok', rows: r.rows.length, ms: Math.round(performance.now() - started) });
    } catch (err) {
      out.push({ scenario: info, status: 'error', rows: 0, ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
