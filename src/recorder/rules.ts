// Rule checks: business rules written as SQL, run against the rows a session touched.
//
// A rules file holds one or more rules. Each starts with a "-- rule: <name>" line and is a single query
// that returns the rows BREAKING the rule; no rows means the rule holds (the dbt-test convention).
// {{orders}} stands for "the orders rows this session inserted or updated", so a rule checks only
// what the test touched. Rules run in a READ ONLY transaction with a timeout: they can't change data.
import type { Db } from '../core/db.js';
import { UserError } from '../core/errors.js';
import { quoteIdent, quoteLiteral, touchedRows, type TouchedTable } from './export/sql.js';
import type { Recording, Row } from './types.js';

export interface Rule {
  name: string;
  sql: string;
  /** Line of the "-- rule:" header, for error messages. */
  line: number;
}

export type RuleStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface RuleResult {
  rule: Rule;
  status: RuleStatus;
  /** Rows in scope per table used with {{...}}, e.g. { "public.orders": 3 }. */
  scope: Record<string, number>;
  /** The first rows that break the rule. */
  violations: Row[];
  /** How many rows break the rule in total. */
  violationCount: number;
  error?: string;
}

export interface CheckOptions {
  /** Let {{table}} mean the whole table instead of the session's rows. */
  allRows?: boolean;
  /** How many violating rows to keep per rule (default 5). */
  limit?: number;
  /** Per-rule statement timeout (default '30s'). */
  timeout?: string;
}

const HEADER = /^\s*--\s*rule:\s*(.+?)\s*$/i;
const MACRO = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Splits a rules file into rules. Text before the first "-- rule:" line may only be comments. */
export function parseRules(text: string, file = 'rules file'): Rule[] {
  const rules: Rule[] = [];
  let current: { name: string; line: number; lines: string[] } | null = null;

  const finish = () => {
    if (!current) return;
    const sql = current.lines.join('\n').trim().replace(/;\s*$/, '').trim();
    const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
    if (!code) throw new UserError(`Rule "${current.name}" (${file}, line ${current.line}) has no query.`);
    rules.push({ name: current.name, sql, line: current.line });
  };

  text.split(/\r?\n/).forEach((line, i) => {
    const header = HEADER.exec(line);
    if (header) {
      finish();
      current = { name: header[1]!, line: i + 1, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() && !/^\s*--/.test(line)) {
      throw new UserError(`${file}, line ${i + 1}: SQL before the first "-- rule: <name>" line.`, 'Start every rule with a line like: -- rule: Payment matches the order total');
    }
  });
  finish();

  if (rules.length === 0) throw new UserError(`${file} has no rules.`, 'Start every rule with a line like: -- rule: Payment matches the order total');
  return rules;
}

// Words that can follow a table in FROM without being its alias.
const NOT_AN_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'on', 'using', 'group', 'order',
  'having', 'window', 'limit', 'offset', 'fetch', 'for', 'union', 'intersect', 'except', 'tablesample', 'lateral',
]);

/** True when the SQL right after a {{table}} gives it an alias of its own ("o", "AS o"). */
export function hasAlias(rest: string): boolean {
  const m = /^\s+(?:as\s+)?("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)/i.exec(rest);
  if (!m) return false;
  return m[1]!.startsWith('"') || !NOT_AN_ALIAS.has(m[1]!.toLowerCase());
}

/** The tables a rule refers to with {{...}}, as written. */
export function macroTables(sql: string): string[] {
  return [...new Set([...sql.matchAll(MACRO)].map((m) => m[1]!))];
}

/** The SQL for one {{table}}: the touched rows as a subquery, or the whole table with allRows. */
export function expandTable(schema: string, table: string, touched: TouchedTable | undefined, allRows: boolean): string {
  const from = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  if (allRows) return from;
  const matches = touched?.matches ?? [];
  if (matches.length === 0) return `(SELECT t.* FROM ${from} t WHERE false)`;
  const list = matches.map((m) => quoteLiteral(JSON.stringify(m))).join(', ');
  return `(SELECT t.* FROM ${from} t WHERE to_jsonb(t.*) @> ANY (ARRAY[${list}]::jsonb[]))`;
}

/** Resolves a name as written in {{...}} (orders, billing.invoices, "Order Lines") the way Postgres would. */
async function resolveTable(db: Db, name: string): Promise<{ schema: string; table: string } | null> {
  const { rows } = await db.query<{ schema: string; table: string }>(`
    SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = to_regclass($1)`, [name]);
  return rows[0] ?? null;
}

function errorMessage(err: unknown): string {
  const e = err as { message?: string; position?: string };
  return e.message ?? String(err);
}

/** Runs each rule against the session's rows. One rule's error doesn't stop the others. */
export async function checkRules(db: Db, rec: Recording | null, rules: Rule[], options: CheckOptions = {}): Promise<RuleResult[]> {
  const allRows = options.allRows ?? false;
  const limit = options.limit ?? 5;
  if (!rec && !allRows) throw new UserError('A session is needed to know which rows to check.', 'Pass a session id, or --all-rows to check whole tables.');
  const touched = rec ? touchedRows(rec) : new Map<string, TouchedTable>();
  const results: RuleResult[] = [];

  await db.query('BEGIN READ ONLY');
  try {
    await db.query(`SET LOCAL statement_timeout = ${quoteLiteral(options.timeout ?? '30s')}`);

    for (const rule of rules) {
      const result: RuleResult = { rule, status: 'pass', scope: {}, violations: [], violationCount: 0 };
      results.push(result);

      // Resolve {{...}} names first, so a typo is reported clearly instead of as a SQL error.
      const expansions = new Map<string, string>();
      for (const name of macroTables(rule.sql)) {
        const resolved = await resolveTable(db, name);
        if (!resolved) {
          Object.assign(result, { status: 'error', error: `Unknown table {{${name}}}.` });
          break;
        }
        const key = `${resolved.schema}.${resolved.table}`;
        const t = touched.get(key);
        result.scope[key] = t?.matches.length ?? 0;
        expansions.set(name, expandTable(resolved.schema, resolved.table, t, allRows));
      }
      if (result.status === 'error') continue;

      // Every table it refers to is empty in this session: nothing to check, which is not a pass.
      const counts = Object.values(result.scope);
      if (!allRows && counts.length > 0 && counts.every((n) => n === 0)) {
        result.status = 'skipped';
        continue;
      }

      // Postgres before 16 needs an alias on every subquery in FROM, so a bare {{orders}} becomes
      // (...) AS "orders": it then behaves exactly like the plain table name, orders.total included.
      const sql = rule.sql.replace(MACRO, (match: string, name: string, offset: number) => {
        const expansion = expansions.get(name)!;
        const rest = rule.sql.slice(offset + match.length);
        if (allRows || hasAlias(rest)) return expansion;
        return `${expansion} AS ${quoteIdent(name.split('.').pop()!.replace(/^"|"$/g, '').replace(/""/g, '"'))}`;
      });
      await db.query('SAVEPOINT propmaster_rule');
      try {
        // Parameters (even none) make pg use the extended protocol, which refuses more than one statement.
        const { rows } = await db.query<Row & { __propmaster_total: string }>(
          `SELECT count(*) OVER () AS __propmaster_total, v.* FROM (${sql}\n) v LIMIT ${limit}`, []);
        result.violationCount = rows.length ? Number(rows[0]!.__propmaster_total) : 0;
        result.violations = rows.map(({ __propmaster_total: _, ...row }) => row);
        result.status = result.violationCount > 0 ? 'fail' : 'pass';
        await db.query('RELEASE SAVEPOINT propmaster_rule');
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT propmaster_rule');
        Object.assign(result, { status: 'error', error: errorMessage(err) });
      }
    }
  } finally {
    await db.query('ROLLBACK');  // read-only anyway; nothing to keep
  }
  return results;
}
