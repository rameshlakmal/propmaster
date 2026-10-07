import { isRawNumber, parseJsonExact } from '../core/json.js';
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

/**
 * The JSON inside a value: a jsonb object or array, or text that holds one. Undefined for anything else
 * (numbers, plain text, NULL), which reads fine on one line.
 */
export function jsonOf(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !isRawNumber(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^[[{]/.test(text)) return undefined;
  try {
    const parsed = parseJsonExact(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** JSON written over several lines, indented two spaces, exact numbers kept; null when the value isn't JSON. */
export function prettyJson(value: unknown): string | null {
  const json = jsonOf(value);
  return json === undefined ? null : JSON.stringify(json, null, 2);
}

export interface JsonChange {
  /** Where in the JSON, e.g. "packages[0].goodsWeight". */
  path: string;
  /** JSON text (objects and arrays indented), or null when the path is missing on that side. */
  before: string | null;
  after: string | null;
}

const MAX_JSON_CHANGES = 30;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !isRawNumber(v);
}

function jsonText(v: unknown): string | null {
  if (v === undefined) return null;
  return v !== null && typeof v === 'object' && !isRawNumber(v) ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

/** Every path inside two JSON values where they differ (at most 30), e.g. "[0].goodsWeight". */
export function jsonChanges(before: unknown, after: unknown, path = '', out: JsonChange[] = []): JsonChange[] {
  if (out.length >= MAX_JSON_CHANGES) return out;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const next = /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
      jsonChanges(before[key], after[key], next, out);
    }
  } else if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) jsonChanges(before[i], after[i], `${path}[${i}]`, out);
  } else if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path: path || '(whole value)', before: jsonText(before), after: jsonText(after) });
  }
  return out;
}

/** For an updated column holding JSON on both sides: what changed inside it. */
export function jsonColumnChanges(before: unknown, after: unknown): JsonChange[] | null {
  const a = jsonOf(before);
  const b = jsonOf(after);
  return a === undefined || b === undefined ? null : jsonChanges(a, b);
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
