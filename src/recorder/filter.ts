import { UserError } from '../core/errors.js';
import { allChanges, OPS, type Change, type Op, type Recording } from './types.js';

export interface Filters {
  /** Table names or patterns: "orders", "billing.*", "order_*". A name without a dot matches any schema. */
  tables?: string[];
  exceptTables?: string[];
  users?: string[];
  apps?: string[];
  ops?: Op[];
  since?: Date;
  until?: Date;
  steps?: number[];
}

export interface Filtered {
  rec: Recording;
  /** How many changes the filters hid. */
  hidden: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when schema.table matches any pattern. A pattern without a dot matches the table name in any schema. */
export function matchesTable(patterns: string[], schema: string, table: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(p.includes('.') ? `${schema}.${table}` : table));
}

function tableMatcher(patterns: string[]): (c: Change) => boolean {
  return (c) => matchesTable(patterns, c.tableSchema, c.tableName);
}

export function hasFilters(f: Filters): boolean {
  return Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined));
}

/** Keeps only matching changes. Steps stay (even if empty), so the timeline keeps its shape, unless --step picks some. */
export function filterRecording(rec: Recording, f: Filters): Filtered {
  const checks: ((c: Change) => boolean)[] = [];
  if (f.tables?.length) checks.push(tableMatcher(f.tables));
  if (f.exceptTables?.length) {
    const excluded = tableMatcher(f.exceptTables);
    checks.push((c) => !excluded(c));
  }
  if (f.users?.length) checks.push((c) => c.dbUser !== null && f.users!.includes(c.dbUser));
  if (f.apps?.length) checks.push((c) => c.appName !== null && f.apps!.includes(c.appName));
  if (f.ops?.length) checks.push((c) => f.ops!.includes(c.op));
  if (f.since) checks.push((c) => c.changedAt >= f.since!);
  if (f.until) checks.push((c) => c.changedAt <= f.until!);

  const steps = rec.steps
    .filter((s) => !f.steps?.length || f.steps.includes(s.seq))
    .map((s) => ({ ...s, changes: s.changes.filter((c) => checks.every((check) => check(c))) }));

  const filtered = { ...rec, steps };
  return { rec: filtered, hidden: allChanges(rec).length - allChanges(filtered).length };
}

export function parseOps(values: string[]): Op[] {
  return values.map((v) => {
    const op = v.toUpperCase();
    if (!OPS.includes(op as Op)) throw new UserError(`Unknown operation "${v}".`, `Use one of: ${OPS.join(', ').toLowerCase()}.`);
    return op as Op;
  });
}

const RELATIVE = /^(\d+)\s*(s|m|h|d)$/i;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses "15m" (ago), "10:30" or "10:30:15" (today, local time), or an ISO date-time. */
export function parseTime(text: string, now = new Date()): Date {
  const relative = RELATIVE.exec(text.trim());
  if (relative) {
    const unit = relative[2]!.toLowerCase() as keyof typeof UNIT_MS;
    return new Date(now.getTime() - Number(relative[1]) * UNIT_MS[unit]);
  }

  const clock = CLOCK.exec(text.trim());
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0);
    return d;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new UserError(`Can't read the time "${text}".`, 'Use 15m, 2h, 10:30, or an ISO date such as 2026-10-07T10:30.');
  }
  return parsed;
}
