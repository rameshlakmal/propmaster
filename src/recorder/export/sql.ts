// SQL assertions: checks that a database ends up in the state a session left it in.
// Each check compares with jsonb containment, `to_jsonb(t.*) @> '{...}'`, using the values the recorder
// captured with to_jsonb, so numbers, timestamps, enums and arrays compare without any type casting.
import { formatDateTime } from '../format.js';
import { noMask, type Masker } from '../mask.js';
import { allChanges, tableKey, type Recording, type Row } from '../types.js';

export interface SqlExportOptions {
  masker?: Masker;
  /** Columns to leave out of every check, such as generated ids, so checks still pass after a re-run. */
  ignoreColumns?: string[];
  /** Keep timestamp/date/time columns (left out by default: they change on every run). */
  includeTimestamps?: boolean;
  /** Emit a DO block that raises an error listing failed checks, for CI. */
  strict?: boolean;
}

interface RowState {
  schema: string;
  table: string;
  key: Row | null;
  /** Latest known values of the columns touched in this session. */
  values: Row;
  /** Full row before it was deleted. */
  deletedRow: Row | null;
  inserted: boolean;
  deleted: boolean;
  step: number;
}

interface Check {
  step: number;
  name: string;
  sql: string;
}

const VOLATILE_TYPE = /^(timestamp|date|time)\b/;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function jsonLiteral(row: Row): string {
  return `${quoteLiteral(JSON.stringify(row))}::jsonb`;
}

function pick(row: Row, keep: (col: string) => boolean): Row {
  return Object.fromEntries(Object.entries(row).filter(([col]) => keep(col)));
}

function describeKey(key: Row | null): string {
  return key ? Object.entries(key).map(([c, v]) => `${c}=${JSON.stringify(v)}`).join(' ') : '(no primary key)';
}

interface Truncation {
  schema: string;
  table: string;
  step: number;
}

/** Folds the session's changes into the final state of each touched row. */
function finalStates(rec: Recording): { rows: RowState[]; truncated: Map<string, Truncation>; skipped: string[] } {
  const rows = new Map<string, RowState>();
  const truncated = new Map<string, Truncation>();
  const skipped: string[] = [];
  let noKeyCounter = 0;

  for (const step of rec.steps) {
    for (const c of step.changes) {
      const table = tableKey(c.tableSchema, c.tableName);

      if (c.op === 'TRUNCATE') {
        for (const [id, state] of rows) if (tableKey(state.schema, state.table) === table) rows.delete(id);
        truncated.set(table, { schema: c.tableSchema, table: c.tableName, step: step.seq });
        continue;
      }

      if (!c.rowKey) {
        // Without a key, only inserted rows can be checked: "a row with these values exists".
        if (c.op === 'INSERT') {
          rows.set(`nokey:${noKeyCounter++}`, {
            schema: c.tableSchema, table: c.tableName, key: null, values: c.newValues ?? {},
            deletedRow: null, inserted: true, deleted: false, step: step.seq,
          });
        } else {
          skipped.push(`${c.op} on ${table} (no primary key, so the row can't be identified)`);
        }
        continue;
      }

      const id = `${table}:${JSON.stringify(c.rowKey)}`;
      const state: RowState = rows.get(id) ?? {
        schema: c.tableSchema, table: c.tableName, key: c.rowKey, values: {},
        deletedRow: null, inserted: false, deleted: false, step: step.seq,
      };
      rows.delete(id);
      state.step = step.seq;

      if (c.op === 'INSERT') {
        Object.assign(state, { inserted: true, deleted: false, deletedRow: null, values: { ...c.newValues } });
      } else if (c.op === 'UPDATE') {
        Object.assign(state.values, c.newValues);
        // When the update changed the key itself, the row is now found by its new key.
        const keyCols = Object.keys(state.key ?? {});
        state.key = { ...state.key, ...pick(c.newValues ?? {}, (col) => keyCols.includes(col)) };
      } else {
        Object.assign(state, { deleted: true, deletedRow: { ...state.values, ...c.oldValues }, values: {} });
      }

      rows.set(`${table}:${JSON.stringify(state.key)}`, state);
    }
  }

  return { rows: [...rows.values()], truncated, skipped };
}

export interface TouchedTable {
  schema: string;
  table: string;
  /** How to find each row the session left behind: its key, or (without a key) all its inserted values. */
  matches: Row[];
}

/** Rows the session inserted or updated and that still exist at its end, per "schema.table". */
export function touchedRows(rec: Recording): Map<string, TouchedTable> {
  const out = new Map<string, TouchedTable>();
  for (const r of finalStates(rec).rows) {
    if (r.deleted) continue;
    const key = tableKey(r.schema, r.table);
    const entry = out.get(key) ?? { schema: r.schema, table: r.table, matches: [] };
    entry.matches.push(r.key ?? r.values);
    out.set(key, entry);
  }
  return out;
}

/** Generates a SQL script of checks; running it after repeating the test should give pass = true everywhere. */
export function toSql(rec: Recording, options: SqlExportOptions = {}): string {
  const masker = options.masker ?? noMask;
  const ignored = new Set(options.ignoreColumns ?? []);
  const leftOut = new Set<string>();

  const usable = (table: string) => (col: string, value: unknown): boolean => {
    if (ignored.has(col)) return false;
    const type = rec.columns[table]?.find((c) => c.name === col)?.type ?? '';
    if (!options.includeTimestamps && VOLATILE_TYPE.test(type)) {
      leftOut.add(`${col} (${type})`);
      return false;
    }
    if (masker(col, value).masked) {
      leftOut.add(`${col} (masked)`);
      return false;
    }
    return true;
  };

  const { rows, truncated, skipped } = finalStates(rec);
  const checks: Check[] = [];

  for (const [table, { schema, table: name, step }] of truncated) {
    const refilled = rows.some((r) => tableKey(r.schema, r.table) === table);
    if (refilled) {
      skipped.push(`emptiness of ${table} after TRUNCATE (rows were added afterwards; those rows are checked)`);
    } else {
      checks.push({ step, name: `${table} is empty (truncated)`, sql: `NOT EXISTS (SELECT 1 FROM ${quoteIdent(schema)}.${quoteIdent(name)})` });
    }
  }

  for (const r of rows) {
    const table = tableKey(r.schema, r.table);
    const from = `${quoteIdent(r.schema)}.${quoteIdent(r.table)} t`;
    const keep = usable(table);
    const key = r.key ? Object.fromEntries(Object.entries(r.key).filter(([c, v]) => keep(c, v))) : {};
    const keyIgnored = r.key !== null && Object.keys(key).length < Object.keys(r.key).length;

    if (r.deleted) {
      // Find the row by its key; if the key is ignored, by everything else it held.
      const match = keyIgnored || !r.key ? pick(r.deletedRow ?? {}, (c) => keep(c, r.deletedRow?.[c])) : key;
      if (Object.keys(match).length === 0) {
        skipped.push(`deletion of ${table} ${describeKey(r.key)} (nothing left to match on)`);
        continue;
      }
      if (r.inserted) {
        checks.push({ step: r.step, name: `${table} ${describeKey(r.key)} was added and removed again`, sql: `NOT EXISTS (SELECT 1 FROM ${from} WHERE to_jsonb(t.*) @> ${jsonLiteral(match)})` });
      } else {
        checks.push({ step: r.step, name: `${table} ${describeKey(r.key)} was deleted`, sql: `NOT EXISTS (SELECT 1 FROM ${from} WHERE to_jsonb(t.*) @> ${jsonLiteral(match)})` });
      }
      continue;
    }

    const values = pick(r.values, (c) => keep(c, r.values[c]));
    const match = { ...key, ...values };
    if (Object.keys(match).length === 0) {
      skipped.push(`${table} ${describeKey(r.key)} (every column is ignored, masked or a timestamp)`);
      continue;
    }

    const cols = Object.keys(values).filter((c) => !(c in key));
    const verb = r.inserted ? 'was inserted' : 'was updated';
    const what = cols.length ? ` with ${cols.join(', ')}` : '';
    checks.push({ step: r.step, name: `${table} ${r.key ? describeKey(r.key) : 'row'} ${verb}${what}`, sql: `EXISTS (SELECT 1 FROM ${from} WHERE to_jsonb(t.*) @> ${jsonLiteral(match)})` });
  }

  checks.sort((a, b) => a.step - b.step);

  const header = [
    '-- Propmaster SQL checks',
    `-- Session #${rec.id} "${rec.name.replace(/\r?\n/g, ' ')}" on ${rec.database}, recorded ${formatDateTime(rec.startedAt)}`,
    '-- Checks that the database is in the state this session left it in.',
    options.strict
      ? '-- Run it after repeating the test. It raises an error naming every failed check.'
      : '-- Run it after repeating the test: every row should say pass = true.',
    `-- ${checks.length} checks from ${allChanges(rec).length} recorded changes.`,
  ];
  if (leftOut.size > 0) {
    header.push(`-- Left out of the checks: ${[...leftOut].sort().join(', ')}.`);
    if ([...leftOut].some((c) => !c.endsWith('(masked)'))) header.push('--   Use --include-timestamps to check timestamp columns too.');
  }
  for (const s of skipped) header.push(`-- Not checked: ${s}.`);
  header.push('');

  if (checks.length === 0) return [...header, '-- Nothing to check.', ''].join('\n');

  const valuesList = checks
    .map((c) => `    (${c.step}, ${quoteLiteral(c.name)}, ${c.sql})`)
    .join(',\n');

  if (!options.strict) {
    return [
      ...header,
      'SELECT step, check_name, pass',
      '  FROM (VALUES',
      valuesList,
      '  ) AS checks (step, check_name, pass)',
      ' ORDER BY step, check_name;',
      '',
    ].join('\n');
  }

  const tag = '$propmaster_checks$';
  const body = [
    'DECLARE',
    '  v_failed text;',
    'BEGIN',
    "  SELECT string_agg(format('step %s: %s', step, check_name), E'\\n' ORDER BY step, check_name)",
    '    INTO v_failed',
    '    FROM (VALUES',
    valuesList.replace(/^ {4}/gm, '      '),
    '    ) AS checks (step, check_name, pass)',
    '   WHERE NOT pass;',
    '',
    '  IF v_failed IS NOT NULL THEN',
    "    RAISE EXCEPTION E'Propmaster checks failed:\\n%', v_failed;",
    '  END IF;',
    `  RAISE NOTICE 'All ${checks.length} Propmaster checks passed.';`,
    'END',
  ].join('\n');
  if (body.includes(tag)) throw new Error('A recorded value contains the SQL quoting tag $propmaster_checks$; use the non-strict format.');

  return [...header, `DO ${tag}`, body, `${tag};`, ''].join('\n');
}
