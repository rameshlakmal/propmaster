// What the web app receives for a session: values already formatted on the server, so exact numbers
// (84.50, big bigints) survive and the browser only has to display strings.
import { summarize } from '../recorder/export/summary.js';
import { isRawNumber } from '../core/json.js';
import { columnDiffs, formatKey, formatValue, jsonColumnChanges, jsonOf, prettyJson, tableLabel, type JsonChange } from '../recorder/format.js';

export { jsonChanges } from '../recorder/format.js';
import type { Recording } from '../recorder/types.js';

export interface ChangeView {
  id: number;
  op: string;
  table: string;
  key: string | null;
  /**
   * Before/after per column: inserts have no before, deletes no after, updates list changed columns.
   * `before`/`after` are written as in SQL ('text', 84.50, NULL), except JSON, which is indented; the kinds
   * tell the browser how to show them.
   */
  columns: {
    column: string; before: string | null; after: string | null; changed: boolean;
    beforeKind: ValueKind | null; afterKind: ValueKind | null;
    /** An updated JSON value: each path inside it that changed, e.g. "[0].goodsWeight" 1000 → 500. */
    jsonChanges?: JsonChange[];
  }[];
  dbUser: string | null;
  appName: string | null;
  changedAt: string;
}

export type ValueKind = 'null' | 'text' | 'number' | 'boolean' | 'timestamp' | 'date' | 'json';

/** What sort of value this is, so the browser can show text without quotes, times readably, and NULL quietly. */
export function valueKind(value: unknown): ValueKind {
  if (value === null || value === undefined) return 'null';
  if (isRawNumber(value) || typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?([+-]\d\d(:?\d\d)?|Z)?$/.test(value)) return 'timestamp';
    if (/^\d{4}-\d\d-\d\d$/.test(value)) return 'date';
    return jsonOf(value) === undefined ? 'text' : 'json';
  }
  return 'json';
}

/** The value as the browser shows it: JSON indented so its structure stays readable, the rest as in SQL. */
function display(value: unknown, kind: ValueKind): string {
  return kind === 'json' ? prettyJson(value)! : formatValue(value); // exact numbers (JSON.rawJSON) are kept
}

export interface MarkerView {
  kind: 'pause' | 'resume' | 'flag';
  note: string | null;
  at: string;
}

export interface RecordingView {
  id: string;
  mode: string;
  name: string;
  database: string;
  startedAt: string;
  stoppedAt: string | null;
  notes: string[];
  summary: { changes: number; tables: number; byOp: Record<string, number> };
  /** Auto steps: the quiet gap (ms) that ends a step. */
  autoSplitMs: number | null;
  steps: { seq: number; name: string; auto: boolean; startedAt: string; changes: ChangeView[]; markers: MarkerView[] }[];
}

export function toView(rec: Recording): RecordingView {
  const s = summarize(rec);
  return {
    id: rec.id,
    mode: rec.mode,
    name: rec.name,
    database: rec.database,
    startedAt: rec.startedAt.toISOString(),
    stoppedAt: rec.stoppedAt?.toISOString() ?? null,
    notes: rec.notes,
    autoSplitMs: rec.autoSplitMs ?? null,
    summary: { changes: s.changes, tables: s.tables, byOp: s.byOp },
    steps: rec.steps.map((step) => ({
      seq: step.seq,
      name: step.name,
      auto: step.auto ?? false,
      startedAt: step.startedAt.toISOString(),
      markers: (step.markers ?? []).map((m) => ({ kind: m.kind, note: m.note, at: m.at.toISOString() })),
      changes: step.changes.map((c) => ({
        id: c.id,
        op: c.op,
        table: tableLabel(c),
        key: formatKey(c),
        columns: columnDiffs(c).map((d) => ({
          column: d.column,
          before: c.op === 'INSERT' ? null : display(d.before, valueKind(d.before)),
          after: c.op === 'DELETE' ? null : display(d.after, valueKind(d.after)),
          changed: d.changed,
          beforeKind: c.op === 'INSERT' ? null : valueKind(d.before),
          afterKind: c.op === 'DELETE' ? null : valueKind(d.after),
          ...(c.op === 'UPDATE' && jsonColumnChanges(d.before, d.after) ? { jsonChanges: jsonColumnChanges(d.before, d.after)! } : {}),
        })),
        dbUser: c.dbUser,
        appName: c.appName,
        changedAt: c.changedAt.toISOString(),
      })),
    })),
  };
}
