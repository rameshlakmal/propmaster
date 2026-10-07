import { isRawNumber } from '../core/json.js';
import type { Change, Row } from './types.js';

/** Formats a value the way it would be written in SQL: 'text', 84.50, NULL. Pass max to shorten long values. */
export function formatValue(value: unknown, max = Infinity): string {
  if (value === null || value === undefined) return 'NULL';
  if (isRawNumber(value)) return value.rawJSON;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const text = typeof value === 'string' ? value.replace(/\r?\n/g, '\\n') : JSON.stringify(value);
  const short = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return typeof value === 'string' ? `'${short}'` : short;
}

export function formatPairs(row: Row | null, skip: ReadonlySet<string> = new Set(), max = Infinity): string {
  return Object.entries(row ?? {})
    .filter(([col]) => !skip.has(col))
    .map(([col, value]) => `${col}=${formatValue(value, max)}`)
    .join(' ');
}

/** "orders", or "billing.invoices" outside the public schema. */
export function tableLabel(change: Pick<Change, 'tableSchema' | 'tableName'>): string {
  return change.tableSchema === 'public' ? change.tableName : `${change.tableSchema}.${change.tableName}`;
}

/** "id=1043", or null when the row has no primary key. */
export function formatKey(change: Change): string | null {
  return change.rowKey ? formatPairs(change.rowKey) : null;
}

export interface ColumnDiff {
  column: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

/** Before/after per column. Inserts have no before, deletes no after, updates list only changed columns. */
export function columnDiffs(change: Change): ColumnDiff[] {
  const columns = Object.keys(change.newValues ?? change.oldValues ?? {});
  return columns.map((column) => ({
    column,
    before: change.oldValues?.[column],
    after: change.newValues?.[column],
    changed: change.op === 'UPDATE',
  }));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local date and time, e.g. "2026-10-07 10:00:01". */
export function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatTime(date)}`;
}

export function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The local UTC offset, e.g. "UTC+05:30". */
export function utcOffset(date = new Date()): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function formatDuration(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
