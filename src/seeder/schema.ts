// What the Seeder and Cleaner need to know about the database: tables, columns, keys, foreign keys,
// unique and check constraints. Read once from the catalogs per command.
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { quoteIdent } from '../recorder/export/sql.js';
import type { Row } from '../recorder/types.js';

export interface Column {
  name: string;
  /** As Postgres writes it (format_type): numeric(10,2), character varying(40), billing.status. Safe to use as a cast. */
  type: string;
  /** The base type's name, domains looked through: int4, varchar, numeric, timestamptz, my_enum. */
  baseType: string;
  /** pg_type.typcategory of the base type: N numeric, S string, B boolean, D date/time, A array, E enum, U user… */
  category: string;
  notNull: boolean;
  /** Has a default (serial counts), so the database fills it when it's left out. */
  hasDefault: boolean;
  /** 'a' GENERATED ALWAYS AS IDENTITY, 'd' BY DEFAULT, '' not an identity column. */
  identity: '' | 'a' | 'd';
  /** A generated (computed) column: it can't be written at all. */
  generated: boolean;
  /** varchar(n) / char(n) length. */
  maxLength?: number;
  /** numeric(p, s). */
  precision?: number;
  scale?: number;
  /** Labels of an enum type, in order. */
  enumLabels?: string[];
}

export type OnDelete = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface ForeignKey {
  name: string;
  /** The table holding the foreign key, as schema.table. */
  table: string;
  columns: string[];
  /** The referenced table, as schema.table. */
  refTable: string;
  refColumns: string[];
  onDelete: OnDelete;
}

export interface Check {
  name: string;
  /** Columns the check reads. */
  columns: string[];
  /** pg_get_constraintdef: CHECK ((qty > 0)). */
  definition: string;
}

export interface Table {
  schema: string;
  name: string;
  /** schema.table */
  key: string;
  columns: Column[];
  primaryKey: string[];
  /** Column sets that must be unique: unique constraints and plain unique indexes (the primary key too). */
  uniques: string[][];
  checks: Check[];
  /** Foreign keys this table holds (pointing at parents). */
  foreignKeys: ForeignKey[];
}

export interface Schema {
  tables: Map<string, Table>;
  /** Schemas searched for unqualified names, in order (the connection's search_path). */
  searchPath: string[];
}

const ON_DELETE: Record<string, OnDelete> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

/** Reads every user table (not Propmaster's own, not the system catalogs). */
export async function loadSchema(db: Db): Promise<Schema> {
  const path = await db.query<{ s: string[] }>('SELECT current_schemas(false)::text[] AS s');

  const cols = await db.query<{
    schema: string; table: string; column: string; type: string; base_type: string; category: string; typtype: string;
    not_null: boolean; has_default: boolean; identity: string; generated: string; typmod: number; base_oid: number; labels: string[] | null;
  }>(`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
           format_type(a.atttypid, a.atttypmod) AS type,
           bt.typname AS base_type, bt.typcategory AS category, bt.typtype,
           a.attnotnull OR coalesce(t.typnotnull, false) AS not_null,
           a.atthasdef OR t.typdefault IS NOT NULL AS has_default,
           a.attidentity::text AS identity, a.attgenerated::text AS generated,
           CASE WHEN t.typtype = 'd' THEN t.typtypmod ELSE a.atttypmod END AS typmod,
           bt.oid::int AS base_oid,
           (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = bt.oid) AS labels
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
     WHERE c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND n.nspname NOT IN ('information_schema', '_propmaster')
       AND n.nspname NOT LIKE 'pg\\_%'
     ORDER BY n.nspname, c.relname, a.attnum`);

  const tables = new Map<string, Table>();
  for (const r of cols.rows) {
    const key = `${r.schema}.${r.table}`;
    let t = tables.get(key);
    if (!t) {
      t = { schema: r.schema, name: r.table, key, columns: [], primaryKey: [], uniques: [], checks: [], foreignKeys: [] };
      tables.set(key, t);
    }
    const col: Column = {
      name: r.column, type: r.type, baseType: r.base_type, category: r.category,
      notNull: r.not_null, hasDefault: r.has_default,
      identity: (r.identity || '') as Column['identity'], generated: Boolean(r.generated),
    };
    if (r.typtype === 'e' && r.labels) col.enumLabels = r.labels;
    if ((r.base_type === 'varchar' || r.base_type === 'bpchar') && r.typmod > 4) col.maxLength = r.typmod - 4;
    if (r.base_type === 'numeric' && r.typmod > 4) {
      col.precision = ((r.typmod - 4) >> 16) & 0xffff;
      col.scale = (r.typmod - 4) & 0xffff;
    }
    t.columns.push(col);
  }

  const cons = await db.query<{
    schema: string; table: string; name: string; kind: string; columns: string[]; ref_schema: string | null; ref_table: string | null;
    ref_columns: string[] | null; on_delete: string; definition: string;
  }>(`
    SELECT n.nspname AS schema, c.relname AS table, k.conname AS name, k.contype::text AS kind,
           ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u (attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord) AS columns,
           rn.nspname AS ref_schema, rc.relname AS ref_table,
           ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u (attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord) AS ref_columns,
           k.confdeltype::text AS on_delete,
           pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class rc ON rc.oid = k.confrelid
      LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE k.contype IN ('p', 'u', 'f', 'c')
       AND k.conparentid = 0
       AND n.nspname NOT IN ('information_schema', '_propmaster')
       AND n.nspname NOT LIKE 'pg\\_%'
     ORDER BY n.nspname, c.relname, k.conname`);

  for (const r of cons.rows) {
    const t = tables.get(`${r.schema}.${r.table}`);
    if (!t) continue;
    if (r.kind === 'p') {
      t.primaryKey = r.columns;
      t.uniques.push(r.columns);
    } else if (r.kind === 'u') {
      t.uniques.push(r.columns);
    } else if (r.kind === 'c') {
      t.checks.push({ name: r.name, columns: r.columns, definition: r.definition });
    } else if (r.kind === 'f' && r.ref_schema && r.ref_table) {
      t.foreignKeys.push({
        name: r.name, table: t.key, columns: r.columns,
        refTable: `${r.ref_schema}.${r.ref_table}`, refColumns: r.ref_columns ?? [],
        onDelete: ON_DELETE[r.on_delete] ?? 'no action',
      });
    }
  }

  // Unique indexes that aren't constraints (CREATE UNIQUE INDEX ...): plain column lists, no expressions or WHERE.
  const idx = await db.query<{ schema: string; table: string; columns: string[] }>(`
    SELECT n.nspname AS schema, c.relname AS table,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY u (attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum ORDER BY u.ord) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.indisunique AND NOT i.indisprimary
       AND i.indexprs IS NULL AND i.indpred IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
       AND n.nspname NOT IN ('information_schema', '_propmaster')
       AND n.nspname NOT LIKE 'pg\\_%'`);
  for (const r of idx.rows) tables.get(`${r.schema}.${r.table}`)?.uniques.push(r.columns);

  return { tables, searchPath: path.rows[0]!.s };
}

/** Postgres folds unquoted names to lower case; a name written with capitals must match exactly. */
function same(a: string, written: string): boolean {
  return a === written || a === written.toLowerCase();
}

/** Finds a table as written in a scenario: customers, billing.invoices. Undefined when there is none. */
export function findTable(schema: Schema, written: string): Table | undefined {
  const dot = written.indexOf('.');
  if (dot > 0) {
    const s = written.slice(0, dot);
    const n = written.slice(dot + 1);
    for (const t of schema.tables.values()) if (same(t.schema, s) && same(t.name, n)) return t;
    return undefined;
  }
  for (const s of schema.searchPath) {
    for (const t of schema.tables.values()) if (t.schema === s && same(t.name, written)) return t;
  }
  return undefined;
}

/** Like findTable, but a missing table is an error that suggests the closest name. */
export function requireTable(schema: Schema, written: string): Table {
  const t = findTable(schema, written);
  if (t) return t;
  const names = [...schema.tables.values()].map((x) => (x.schema === 'public' ? x.name : x.key));
  const close = closest(written, names);
  throw new UserError(`There is no table "${written}".`, close ? `Did you mean "${close}"?` : undefined);
}

export function column(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => same(c.name, name));
}

/** Foreign keys in other tables (or this one) that point at this table: its children. */
export function referencing(schema: Schema, table: Table): ForeignKey[] {
  const out: ForeignKey[] = [];
  for (const t of schema.tables.values()) for (const fk of t.foreignKeys) if (fk.refTable === table.key) out.push(fk);
  return out;
}

/** "public.orders" → "orders"; other schemas keep their name. */
export const shortName = (key: string): string => key.replace(/^public\./, '');

/** A row's values in the table's column order (jsonb sorts keys by length). Unknown keys go last. */
export function inColumnOrder(table: Table, row: Row): Row {
  const ordered: Row = {};
  for (const c of table.columns) if (c.name in row) ordered[c.name] = row[c.name];
  for (const [k, v] of Object.entries(row)) if (!(k in ordered)) ordered[k] = v;
  return ordered;
}

export const qualified = (t: Pick<Table, 'schema' | 'name'>): string => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;

/** The nearest of `options` to `word` by edit distance, if it's close enough to be a likely typo. */
export function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const o of options) {
    const d = distance(word.toLowerCase(), o.toLowerCase());
    if (d < bestDistance) { best = o; bestDistance = d; }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}
