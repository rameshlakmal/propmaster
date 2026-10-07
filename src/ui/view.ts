// What the web app receives for a session: values already formatted on the server, so exact numbers
// (84.50, big bigints) survive and the browser only has to display strings.
import { summarize } from '../recorder/export/summary.js';
import { columnDiffs, formatKey, formatValue, tableLabel } from '../recorder/format.js';
import type { Recording } from '../recorder/types.js';

export interface ChangeView {
  id: number;
  op: string;
  table: string;
  key: string | null;
  /** Before/after per column: inserts have no before, deletes no after, updates list changed columns. */
  columns: { column: string; before: string | null; after: string | null; changed: boolean }[];
  dbUser: string | null;
  appName: string | null;
  changedAt: string;
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
  steps: { seq: number; name: string; startedAt: string; changes: ChangeView[]; markers: MarkerView[] }[];
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
    summary: { changes: s.changes, tables: s.tables, byOp: s.byOp },
    steps: rec.steps.map((step) => ({
      seq: step.seq,
      name: step.name,
      startedAt: step.startedAt.toISOString(),
      markers: (step.markers ?? []).map((m) => ({ kind: m.kind, note: m.note, at: m.at.toISOString() })),
      changes: step.changes.map((c) => ({
        id: c.id,
        op: c.op,
        table: tableLabel(c),
        key: formatKey(c),
        columns: columnDiffs(c).map((d) => ({
          column: d.column,
          before: c.op === 'INSERT' ? null : formatValue(d.before),
          after: c.op === 'DELETE' ? null : formatValue(d.after),
          changed: d.changed,
        })),
        dbUser: c.dbUser,
        appName: c.appName,
        changedAt: c.changedAt.toISOString(),
      })),
    })),
  };
}
